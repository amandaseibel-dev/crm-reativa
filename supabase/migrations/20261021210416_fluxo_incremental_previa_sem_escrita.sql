-- RODADA INCREMENTAL · A PRÉVIA PASSA A SER GARANTIA, NÃO PROMESSA
--
-- `create or replace` da função criada pela 20261021195950. UM statement.
-- Zero DML, zero objeto novo, zero cron. Assinatura, parâmetros, fila, lote,
-- orçamento de tempo, trava, guarda de carga, espera, contagem, indicadores,
-- registro e retorno ficam IDÊNTICOS. A ÚNICA mudança é como o motor é chamado
-- no modo prévia.
--
-- ===========================================================================
-- O PROBLEMA: "prévia" dependia de auditar 24.824 caracteres e acreditar
-- ===========================================================================
--
-- `pagamento_conciliar_um` tem CINCO caminhos de escrita. Levantados em
-- 21/10/2026, na ordem em que aparecem no corpo:
--
--   1. `if p_aplicar then` -> insert into public.auditoria        (com guarda)
--   2. `if not p_aplicar then return` -> update public.parcelas   (com guarda)
--   3. `if not p_aplicar then return` -> update public.pagamentos (com guarda)
--   4.                                   update public.fila_... set decisao
--   5.                                   insert into public.fila_pagamento_sem_vinculo
--
-- Os quatro primeiros estão atrás de guarda. O QUINTO aparece depois das
-- guardas no TEXTO -- e posição no texto NÃO É PROVA DE FLUXO DE CONTROLE: um
-- `elsif` ou um bloco aninhado pode alcançá-lo sem passar pela guarda. Some-se
-- a isso o que a medição mostrou: 386 de 386 linhas da fila sem decisão foram
-- tentadas nas últimas 24h, com o cron horário desligado desde 24/09 -- ou
-- seja, há caminho vivo que escreve na fila fora da rodada.
--
-- E GATILHOS. Mesmo que hoje os cinco estivessem todos guardados, qualquer
-- gatilho em `pagamentos`, `parcelas`, `auditoria` ou na fila pode escrever por
-- efeito indireto, e nenhuma auditoria de corpo de função cobre isso.
--
-- Auditar texto para prometer pureza é frágil por desenho: vale até a próxima
-- alteração do motor, feita por outra frente, sem ninguém relembrar a promessa.
--
-- ===========================================================================
-- A CORREÇÃO: subtransação SEMPRE revertida
-- ===========================================================================
--
-- No modo prévia a chamada ao motor roda dentro de um bloco `begin/exception`,
-- que em PL/pgSQL é uma SUBTRANSAÇÃO. Depois de capturar o resultado, a função
-- levanta de propósito um erro com SQLSTATE próprio `PV001`, e o trata. O
-- efeito: TODA escrita feita ali dentro -- pelo motor, por gatilho, por efeito
-- indireto, hoje ou depois de qualquer mudança futura -- é DESFEITA pelo banco.
--
-- Isto inverte o ônus. Não é mais "o motor promete não escrever"; é "o banco
-- desfaz o que ele escrever". Vale para o quinto caminho, para os gatilhos e
-- para o que ainda não existe.
--
-- POR QUE O RESULTADO SOBREVIVE: variáveis de PL/pgSQL não são transacionais --
-- vivem na memória do executor, não no banco. Reverter a subtransação apaga as
-- escritas e NÃO apaga `v_r`. Há teste que prova isto com um dublê que escreve
-- em seis tabelas e devolve valor: as escritas desaparecem, o valor fica.
--
-- O `p_aplicar => false` CONTINUA sendo passado ao motor. As duas defesas
-- somam: ele não deve escrever, e se escrever, é desfeito.
--
-- O REGISTRO DE MONITORAMENTO É A ÚNICA ESCRITA QUE SOBRA, e de propósito: ele
-- é inserido FORA da subtransação, depois do laço, para a prévia continuar
-- aparecendo em `vw_fluxo_pagamentos_monitor`.
--
-- RESSALVA DECLARADA: se o próprio motor levantasse um erro com SQLSTATE
-- `PV001`, a prévia o trataria como o sinal interno de reversão em vez de
-- contá-lo como erro. `PV001` não é usado em lugar nenhum do schema -- foi
-- escolhido por isso -- e o pior caso é um erro não contado, nunca uma escrita
-- vazada.
--
-- Reversível: supabase/rollbacks/20261021213500_*.rollback.sql

create or replace function public.fluxo_pagamentos_incremental(
  p_lote            int default 40,
  p_segundos        int default 20,
  p_tentativas_max  int default 8,
  p_espera_horas    int default 24,
  p_aplicar         boolean default true
)
returns jsonb
language plpgsql
volatile
security definer
set search_path to 'public'
as $fn$
declare
  v_ini        timestamptz := clock_timestamp();
  v_prazo      timestamptz;
  v_email      text := coalesce(auth.jwt() ->> 'email','server');
  v_carga      jsonb;
  v_id         uuid;
  v_r          jsonb;
  v_st         text;
  v_conta      jsonb := '{}'::jsonb;
  v_proc       int := 0;
  v_baixou     int := 0;
  v_erros      int := 0;
  v_erro1      text;
  v_antes      numeric;
  v_depois     numeric;
  v_pend       int;
  v_res        jsonb;
  v_ind        text := 'nao_precisou';
begin
  if not (public.calibragem_e_gestao() or auth.jwt() is null) then
    raise exception 'Sem permissão para rodar o fluxo de pagamentos.' using errcode = '42501';
  end if;

  if coalesce(p_lote,0) < 1     then p_lote := 40; end if;
  if coalesce(p_segundos,0) < 1 then p_segundos := 20; end if;
  -- Teto duro: esta rodada nunca segura o banco por mais de 2 minutos.
  if p_segundos > 120 then p_segundos := 120; end if;
  if p_lote > 500 then p_lote := 500; end if;
  v_prazo := v_ini + make_interval(secs => p_segundos);

  -- PROTEÇÃO 1 -- trava. `try` e não `wait`: rodada ocupada não enfileira.
  if not pg_try_advisory_xact_lock(hashtext('fluxo_pagamentos_incremental')) then
    v_res := jsonb_build_object('pulou','rodada anterior ainda em curso',
                                'duracao_ms', 0);
    insert into public.fluxo_pagamentos_execucoes (origem, resultado)
      values ('incremental', v_res);
    return v_res;
  end if;

  -- PROTEÇÃO 2 -- carga do banco.
  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean, false) then
    v_res := jsonb_build_object('pulou','sistema sob carga', 'carga', v_carga,
                                'duracao_ms', 0);
    insert into public.fluxo_pagamentos_execucoes (origem, resultado)
      values ('incremental', v_res);
    return v_res;
  end if;

  -- PROTEÇÃO 3 -- teto por consulta. Um pagamento patológico não trava a rodada.
  perform set_config('statement_timeout', '15s', true);
  -- Marca a origem para quem checa `reativa.fluxo_pagamentos`, como a antiga fazia.
  perform set_config('reativa.fluxo_pagamentos','on', true);

  select round(coalesce(sum(saldo_total),0),2) into v_antes from public.alunos;

  -- A FILA. Derivada do estado, sem cursor: o resolvido sai, o pendente volta.
  for v_id in
    select p.id
      from public.pagamentos p
      left join public.fila_pagamento_sem_vinculo f
             on f.pagamento_id = p.id and f.decisao is null
     -- A FRONTEIRA DE 14/09: NULL = anterior ao motor, invisível por decisão.
     where p.status_conciliacao is not null
       and p.status_conciliacao <> 'BAIXADO'
       -- o que a gestão já decidiu não volta sozinho
       and not exists (select 1 from public.fila_pagamento_sem_vinculo d
                        where d.pagamento_id = p.id and d.decisao is not null)
       -- PROTEÇÃO 5 -- espera: muitas tentativas sem decisão = no máximo uma
       -- por janela, em vez de a cada hora.
       and (f.pagamento_id is null
            or coalesce(f.quantidade_tentativas,0) < p_tentativas_max
            or coalesce(f.ultima_tentativa_em, '-infinity'::timestamptz)
               <= now() - make_interval(hours => p_espera_horas))
     -- quem nunca foi tentado primeiro; depois o mais antigo sem tentar há mais tempo
     order by coalesce(f.quantidade_tentativas, 0) asc,
              coalesce(f.ultima_tentativa_em, '-infinity'::timestamptz) asc,
              p.data_pagamento asc, p.id asc
     limit p_lote
  loop
    -- PROTEÇÃO 3 -- orçamento de tempo, conferido a cada pagamento.
    exit when clock_timestamp() >= v_prazo;

    if p_aplicar then
      begin
        v_r := public.pagamento_conciliar_um(v_id, true);
      exception when others then
        -- Um pagamento com problema não derruba a rodada inteira.
        v_r := null;
        v_erros := v_erros + 1;
        if v_erro1 is null then v_erro1 := left(SQLERRM, 300); end if;
      end;
    else
      -- PRÉVIA: subtransação SEMPRE revertida. O que o motor, um gatilho ou um
      -- efeito indireto escrever aqui dentro é DESFEITO pelo banco. `v_r`
      -- sobrevive porque variável de PL/pgSQL não é transacional.
      begin
        v_r := public.pagamento_conciliar_um(v_id, false);
        raise exception 'previa revertida' using errcode = 'PV001';
      exception
        when sqlstate 'PV001' then
          null; -- o sinal interno: a reversão aconteceu, `v_r` está preenchido
        when others then
          v_r := null;
          v_erros := v_erros + 1;
          if v_erro1 is null then v_erro1 := left(SQLERRM, 300); end if;
      end;
    end if;

    if v_r is not null then
      v_proc := v_proc + 1;
      v_st := coalesce(v_r->>'status','?');
      v_conta := jsonb_set(v_conta, array[v_st],
                           to_jsonb(coalesce((v_conta->>v_st)::int, 0) + 1), true);
      if coalesce((v_r->>'baixou')::boolean, false) then v_baixou := v_baixou + 1; end if;
    end if;
  end loop;

  select count(*) into v_pend
    from public.pagamentos p
   where p.status_conciliacao is not null and p.status_conciliacao <> 'BAIXADO';

  select round(coalesce(sum(saldo_total),0),2) into v_depois from public.alunos;

  -- INDICADORES. Só depois de processamento CONFIRMADO, e só se algo baixou --
  -- recalcular sem fato novo é gastar banco de graça. A TV ReATIVA
  -- (`obter_metricas_tv_reativa`) calcula AO VIVO e não lê snapshot: ela já
  -- reflete a baixa no instante do commit, sem ação manual. O que tem snapshot
  -- é o gerencial, e o portão dele é de gestão -- por isso vai dentro de
  -- `exception`: falhar aqui não pode desfazer baixa legítima.
  if p_aplicar and v_baixou > 0 then
    begin
      perform public.atualizar_snapshots_gerenciais(null);
      v_ind := 'atualizado';
    exception when others then
      v_ind := 'falhou: ' || left(SQLERRM, 150);
    end;
  end if;

  v_res := jsonb_build_object(
    'modo',          case when p_aplicar then 'aplicado' else 'previa' end,
    'previa_revertida', not p_aplicar,
    'processados',   v_proc,
    'baixados',      v_baixou,
    'erros',         v_erros,
    'primeiro_erro', v_erro1,
    'pendentes',     v_pend,
    'por_status',    v_conta,
    'lote',          p_lote,
    'orcamento_s',   p_segundos,
    'esgotou_tempo', clock_timestamp() >= v_prazo,
    'indicadores',   v_ind,
    'duracao_ms',    round(extract(epoch from (clock_timestamp() - v_ini)) * 1000)::int);

  insert into public.fluxo_pagamentos_execucoes
    (origem, carteira_antes, carteira_depois, resultado, erro)
    values ('incremental', v_antes, v_depois, v_res, v_erro1);

  return v_res;
end;
$fn$;

comment on function public.fluxo_pagamentos_incremental(int,int,int,int,boolean) is
  'Rodada incremental e segura do fluxo de pagamentos: lote pequeno, orçamento '
  'de tempo, trava de concorrência, guarda de carga e espera para quem já '
  'falhou muitas vezes. NÃO chama parcelas_amarrar_boleto (a varredura global '
  'que derrubou o banco em 24/09/2026) e NÃO toca nos pagamentos anteriores à '
  'fronteira de 14/09. No modo prévia (p_aplicar => false) a chamada ao motor '
  'roda em subtransação SEMPRE revertida, então nenhuma escrita dele, de '
  'gatilho ou de efeito indireto persiste -- só o registro de monitoramento, '
  'que é gravado fora dela. A decisão financeira é toda de pagamento_conciliar_um.';
