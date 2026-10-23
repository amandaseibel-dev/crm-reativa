-- ROLLBACK de 20261023004500_fluxo_incremental_reserva_bloqueado.sql
--
-- O QUE REVERTER REINTRODUZ, EM LETRAS MAIÚSCULAS:
--
--   O ORÇAMENTO DA RODADA VOLTA A SER GASTO MAJORITARIAMENTE EM PENDÊNCIA SEM
--   PORTA DE SAÍDA. Medido em 22/10/2026: das 325 avaliações de um dia (13
--   rodadas × lote 25), 214 vão para as 265 pendências bloqueadas pela etapa
--   `consulta_portador`, desligada pela gestão desde 15/09/2026 -- e as 150
--   pendências com saída recebem 111, menos de uma por pendência por dia.
--
--   Nada de dinheiro é desfeito: este rollback não dá baixa, não tira baixa,
--   não mexe em `status_conciliacao`, em `decisao`, em etapa, em job nem no
--   contador de tentativas. Ele só devolve a política de orçamento anterior.
--
-- ZERO DML nos dois sentidos.
--
-- ESTE ROLLBACK É EXECUTÁVEL, e se autoconfere: o corpo restaurado é o de
-- 20261021223117 copiado byte a byte, e o portão no fim recusa se o md5 não
-- for exatamente o que estava em produção em 22/10/2026
-- (11c14ef5bcbc4283357de8ef2d798c5e, 6.813 bytes). Se o corpo divergir --
-- porque alguém alterou a função no meio do caminho --, o rollback FALHA em
-- vez de sobrescrever trabalho de outra pessoa em silêncio.
--
-- NÃO use `drop function`: removeria a rodada inteira em vez de reverter esta
-- mudança, e quebraria os jobs de cron 73/74/75.

-- ---------------------------------------------------------------------------
-- 1. A FUNÇÃO volta ao corpo de 21/10 (migration 20261021223117), sem a
--    reserva e sem as chaves novas do retorno.
-- ---------------------------------------------------------------------------
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
     -- PROTEÇÃO 5 -- ESPERA, agora por ORDENAÇÃO e não por exclusão. Veja o
     -- cabeçalho: excluir por `ultima_tentativa_em` deixava 365 de 386 fora,
     -- porque um gatilho reescreve esse campo em QUALQUER update da linha.
     -- Aqui o veterano recém-tentado vai para o FIM da fila, nunca para fora.
     order by (case when coalesce(f.quantidade_tentativas,0) >= p_tentativas_max
                     and coalesce(f.ultima_tentativa_em, '-infinity'::timestamptz)
                         > now() - make_interval(hours => p_espera_horas)
                    then 1 else 0 end) asc,
              coalesce(f.quantidade_tentativas, 0) asc,
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
  'que é gravado fora dela. A espera DESPRIORIZA o veterano recém-tentado, '
  'nunca o exclui: nenhum pendente fica invisível. A decisão financeira é toda '
  'de pagamento_conciliar_um.';

-- ---------------------------------------------------------------------------
-- 2. O MONITOR volta às 15 colunas de 21/10, com a opção e os privilégios de
--    20261021210208 reafirmados -- reverter a reserva não pode reabrir a
--    escrita na trilha.
-- ---------------------------------------------------------------------------
drop view if exists public.vw_fluxo_pagamentos_monitor;

create view public.vw_fluxo_pagamentos_monitor
with (security_invoker = true) as
select e.rodou_em,
       e.origem,
       coalesce(e.resultado->>'pulou', e.resultado->>'modo')      as situacao,
       (e.resultado->>'processados')::int                          as processados,
       (e.resultado->>'baixados')::int                             as baixados,
       (e.resultado->>'pendentes')::int                            as pendentes,
       (e.resultado->>'erros')::int                                as erros,
       (e.resultado->>'duracao_ms')::int                           as duracao_ms,
       (e.resultado->>'esgotou_tempo')::boolean                    as esgotou_tempo,
       e.resultado->>'indicadores'                                 as indicadores,
       e.resultado->'por_status'                                   as por_status,
       e.erro                                                      as erro,
       e.carteira_antes, e.carteira_depois,
       round(extract(epoch from (now() - e.rodou_em))/60)::int      as minutos_atras
  from public.fluxo_pagamentos_execucoes e
 order by e.rodou_em desc;

comment on view public.vw_fluxo_pagamentos_monitor is
  'Monitor do fluxo de pagamentos: última execução, situação, processados, '
  'baixados, pendentes, erros e duração. Uma linha por rodada.';

revoke all on public.vw_fluxo_pagamentos_monitor from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.vw_fluxo_pagamentos_monitor from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.vw_fluxo_pagamentos_monitor from service_role;
grant select on public.vw_fluxo_pagamentos_monitor to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. PORTÃO: o rollback se autoconfere, byte a byte.
-- ---------------------------------------------------------------------------
do $guarda$
declare
  v_md5 text;
begin
  select md5(p.prosrc) into v_md5
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental';

  if v_md5 <> '11c14ef5bcbc4283357de8ef2d798c5e' then
    raise exception
      'ROLLBACK ABORTADO: o corpo restaurado tem md5 % e nao o de 21/10/2026 '
      '(11c14ef5bcbc4283357de8ef2d798c5e). Alguem alterou a funcao depois da '
      'migration 20261023004500 -- confira antes de sobrescrever.', v_md5;
  end if;

  -- A reserva tem de ter sumido de verdade.
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental'
                and position('vw_fila_pagamento_triagem' in p.prosrc) > 0) then
    raise exception 'ROLLBACK ABORTADO: a rodada ainda le a triagem.';
  end if;

  -- E o monitor nao pode voltar aberto.
  if has_table_privilege('authenticated', 'public.vw_fluxo_pagamentos_monitor', 'DELETE') then
    raise exception 'ROLLBACK ABORTADO: o monitor voltou gravavel por authenticated.';
  end if;
end
$guarda$;
