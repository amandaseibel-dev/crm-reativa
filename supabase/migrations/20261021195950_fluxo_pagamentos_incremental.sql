-- FLUXO DE PAGAMENTOS · RODADA INCREMENTAL SEGURA
--
-- Substitui a rodada horária que derrubou o banco em 24/09/2026 por uma que não
-- faz varredura global. Cria UMA função e UMA view. NÃO agenda cron: a ativação
-- é passo separado, com autorização própria da gestão.
--
-- ===========================================================================
-- POR QUE A ANTIGA CAIU, medido em 21/10/2026
-- ===========================================================================
--
-- `fluxo_pagamentos_horario` (job 38) chamava `fluxo_pagamentos_rodar('cron')`,
-- cuja primeira etapa ligada é `parcelas_amarrar_boleto()`. A etapa A dessa
-- função monta a temp table `_anc` com:
--
--   acordos_titulos t JOIN acordos a ON a.aluno_id = t.aluno_id
--                     JOIN parcelas  p ON p.acordo_id = a.id
--
-- O único predicado entre `t` e `a` é o ALUNO. Para cada aluno, isso cruza
-- todos os títulos tipo Acordo × todos os acordos × todas as parcelas daqueles
-- acordos -- um produto que cresce com o cubo do histórico do aluno, sobre
-- 51.906 títulos, 4.800 acordos e 16.654 parcelas. Foi ali que o
-- `statement timeout` estourou às 19:40 de 24/09, depois de três
-- `server restarted` no mesmo dia.
--
-- `public.pagamentos` tem 10.636 linhas. O problema NUNCA esteve em varrer
-- pagamentos; esteve em recalcular o universo de acordos a cada hora.
--
-- ESTA RODADA NÃO CHAMA `parcelas_amarrar_boleto()`. É a decisão central aqui.
-- Amarrar boleto a parcela é saneamento de base, não trabalho de hora em hora:
-- continua disponível para ser rodado sob demanda, fora do caminho automático.
--
-- ===========================================================================
-- O QUE FOI REUSADO, em vez de reescrito
-- ===========================================================================
--
--   pagamento_conciliar_um(uuid, boolean)   o motor, UM pagamento por vez
--   fila_pagamento_sem_vinculo              a fila de divergência da gestão,
--                                           com quantidade_tentativas e
--                                           ultima_tentativa_em já existentes
--   fluxo_pagamentos_execucoes              onde a execução é registrada
--   sistema_sob_carga()                     a guarda de carga que já existia
--   fluxo_pagamentos_config                 o liga/desliga por etapa
--
-- A lógica de decisão financeira é do motor e NÃO foi tocada: quem decide se
-- baixa, e com que evidência, continua sendo `pagamento_conciliar_um`. Esta
-- função é só o agendador seguro em volta dele.
--
-- ===========================================================================
-- OS 296 `AGUARDANDO_ACORDO` E A CONSULTA DE PORTADOR -- sem presumir nada
-- ===========================================================================
--
-- O motivo gravado neles diz "a rodada horaria consulta" a API oficial. Medido
-- em 21/10/2026, contra `docs/integracoes/` (fonte oficial versionada):
--
--   * os 296 estão TODOS em `fila_pagamento_sem_vinculo` -- o encaminhamento à
--     fila já acontece; só 5 têm decisão da gestão;
--   * `consulta_portador_em` é NULO em 296 de 296, e
--     `consulta_estrutura_resultado` é NULO em toda a tabela: a consulta
--     NUNCA rodou uma única vez;
--   * `auditoria` com `acao='ACORDO_ENCONTRADO_NA_API'`: **0 linhas** --
--     `/students/{reg}/agreements` nunca devolveu lista preenchida em produção;
--   * `prime-gaps.md` classifica "estrutura financeira do acordo (parcelas,
--     valor negociado, vencimentos)" como VERMELHO: não exposta pela
--     superfície pública testada (48 rotas candidatas, todas 404 exceto
--     `/agreements`, que responde vazio);
--   * dos 296, ZERO são à vista -- então `recuperar_acordo_avista`, que está
--     ligada, não os alcança;
--   * `consulta_portador` está DESLIGADA e seus dois leitores
--     (`conciliacao_reprocessar`, `conciliacao_consultar_portador_pendentes`)
--     não eram chamados pela rodada horária.
--
-- CONCLUSÃO, declarada e não presumida: NÃO HÁ EVIDÊNCIA de que a API forneça a
-- estrutura do acordo que falta, e há evidência documentada de que não forneça.
-- Religar a rodada, por si, NÃO resolveria os 296. Eles dependem de o acordo
-- entrar no CRM (pela importação do relatório de acordos ou pelo registro da
-- gestão) -- não de uma consulta. Por isso esta função NÃO promete resolvê-los:
-- ela para de girar em falso sobre eles e os deixa visíveis na fila.
--
-- O GIRO EM FALSO, medido: `quantidade_tentativas` chega a 241 numa linha, com
-- média 54,1, e 386 de 386 linhas sem decisão foram tentadas nas últimas 24h --
-- mesmo com o cron desligado desde 24/09, porque a rota de importação também
-- aciona o motor. Reavaliar 296 casos sem saída a cada rodada é o que empurra
-- pagamento novo para o fim da fila.
--
-- ===========================================================================
-- AS CINCO PROTEÇÕES DESTA RODADA
-- ===========================================================================
--
--   1. TRAVA  `pg_try_advisory_xact_lock`: se a rodada anterior ainda corre,
--             esta sai na hora, sem enfileirar. Duas nunca se somam.
--   2. CARGA  `sistema_sob_carga()`: se o banco está ocupado, pula e registra.
--   3. TEMPO  orçamento em segundos, conferido a CADA pagamento com
--             `clock_timestamp()`, mais `statement_timeout` local por consulta.
--             A rodada para no meio e a próxima continua de onde parou.
--   4. LOTE   teto de pagamentos por rodada.
--   5. ESPERA pagamento que já falhou muitas vezes e segue sem decisão da
--             gestão é tentado no máximo uma vez por janela de espera, em vez
--             de a cada hora. Quem nunca foi tentado vai PRIMEIRO.
--
-- RETOMADA SEGURA: não há cursor para corromper. A fila é derivada do estado --
-- `status_conciliacao <> 'BAIXADO'` -- então o que foi resolvido sai sozinho e
-- o que sobrou reaparece na próxima. Interromper no meio não perde nem repete.
--
-- A FRONTEIRA DE 14/09 É RESPEITADA: `status_conciliacao is not null` mantém os
-- 8.955 pagamentos de 01/07 a 11/09 (R$ 12,3 mi) invisíveis para o automático,
-- como decidido. Esta função não reclassifica nem baixa nenhum deles.
--
-- ZERO DML nesta migration: ela cria função e view e mais nada. Nenhum
-- pagamento é conciliado, nenhuma baixa é dada, nenhum cron é agendado.
--
-- Reversível: supabase/rollbacks/20261021210000_*.rollback.sql

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

    begin
      v_r := public.pagamento_conciliar_um(v_id, p_aplicar);
      v_proc := v_proc + 1;
      v_st := coalesce(v_r->>'status','?');
      v_conta := jsonb_set(v_conta, array[v_st],
                           to_jsonb(coalesce((v_conta->>v_st)::int, 0) + 1), true);
      if coalesce((v_r->>'baixou')::boolean, false) then v_baixou := v_baixou + 1; end if;
    exception when others then
      -- Um pagamento com problema não derruba a rodada inteira.
      v_erros := v_erros + 1;
      if v_erro1 is null then v_erro1 := left(SQLERRM, 300); end if;
    end;
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
  'fronteira de 14/09. A decisão financeira é toda de pagamento_conciliar_um.';

-- ---------------------------------------------------------------------------
-- MONITORAMENTO. Uma linha por execução, já legível.
-- ---------------------------------------------------------------------------
create or replace view public.vw_fluxo_pagamentos_monitor as
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

-- ---------------------------------------------------------------------------
-- PERMISSÕES. Função nova nasce com EXECUTE para PUBLIC -- herança do Postgres,
-- corrigida hoje na 20261021180155. Aqui já nasce fechada. View segue o padrão
-- da casa: leitura para quem está logado.
-- ---------------------------------------------------------------------------
revoke all on function public.fluxo_pagamentos_incremental(int,int,int,int,boolean) from public;
revoke all on function public.fluxo_pagamentos_incremental(int,int,int,int,boolean) from anon;
grant execute on function public.fluxo_pagamentos_incremental(int,int,int,int,boolean)
  to authenticated, service_role;

revoke all on public.vw_fluxo_pagamentos_monitor from anon;
grant select on public.vw_fluxo_pagamentos_monitor to authenticated, service_role;
