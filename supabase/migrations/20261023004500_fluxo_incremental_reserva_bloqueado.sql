-- RODADA INCREMENTAL · O LOTE DEIXA DE SER GASTO EM PENDÊNCIA SEM PORTA
--
-- `create or replace` da MESMA função, com a MESMA assinatura, mais duas
-- colunas no fim da view de monitoramento. Zero DML. Zero cron. Zero etapa
-- religada. Zero baixa. Nenhuma pendência sai da fila, nenhuma é marcada como
-- resolvida, nenhum `status_conciliacao` e nenhum `decisao` é tocado.
--
-- ESTA MIGRATION NÃO FOI APLICADA EM PRODUÇÃO.
--
-- DEPENDE DA PR #737 (`20261023000700_fila_pagamento_triagem.sql`) estar
-- aplicada antes: a classificação de "bloqueado por etapa desativada" vem
-- INTEIRA da `vw_fila_pagamento_triagem`. O portão no topo deste arquivo
-- recusa a migration se a view não existir, em vez de duplicar a
-- classificação -- duas definições de "bloqueado" divergiriam no primeiro dia.
--
-- ===========================================================================
-- O FATO, medido em produção em 22/10/2026 (somente leitura)
-- ===========================================================================
--
--   pendências (`status_conciliacao` não nulo e <> 'BAIXADO')   448   R$ 377.515,27
--   fora do alcance da rodada (gestão já decidiu)                33
--   ELEGÍVEIS para a rodada                                     415
--     · BLOQUEADO_ETAPA_DESATIVADA                              265   R$ 186.318,47
--     · com alguma porta de saída                               150
--
-- As 265 dependem de `consulta_portador`, DESLIGADA pela gestão desde
-- 15/09/2026 em `fluxo_pagamentos_config`. `consulta_portador_em` é nulo em
-- 329 de 329 pendências `AGUARDANDO_ACORDO`: a consulta que o texto do motivo
-- promete nunca aconteceu para nenhuma. A rodada devolve `baixados: 0` em
-- TODAS as execuções desde 21/10, e `pendentes` subiu 420 -> 448 no dia 22/10.
--
-- O CUSTO, MEDIDO E NÃO SUPOSTO. O lote instantâneo não denuncia o problema --
-- o top 25 de agora tem só 4 bloqueados, porque a ordenação por
-- `quantidade_tentativas` faz rodízio. O dia inteiro denuncia:
--
--   top 25 de uma rodada          4 bloqueados   21 com saída
--   top 325 (13 rodadas = 1 dia) 214 bloqueados  111 com saída   <-- 66%
--
-- Dois terços do orçamento diário vão para a categoria cuja única porta está
-- fechada por decisão de negócio, e as 150 com saída recebem 111 avaliações
-- por dia -- menos de uma por pendência. Quando um humano resolve um caso
-- acionável, ou quando o acordo finalmente entra no CRM, a rodada demora mais
-- de um dia para perceber.
--
-- ===========================================================================
-- A DECISÃO: RESERVAR UMA FRAÇÃO DO LOTE, e não excluir nem despriorizar
-- ===========================================================================
--
-- Alternativa (c) das três avaliadas. A reserva é de 20% do lote: com o lote
-- 25 dos jobs 73/74/75, 5 vagas por rodada para os bloqueados e 20 para quem
-- tem saída. Projeção com os números de hoje e as 13 rodadas que aplicam:
--
--                       hoje            com a reserva
--   com saída (150)     111 avaliações/dia   260/dia  -> as 150 são vistas todo dia
--   bloqueados (265)    214 avaliações/dia    65/dia  -> cada uma a cada ~4 dias
--
-- A RESERVA É PISO, NÃO TETO. Se houver menos pendências com saída do que o
-- lote, os bloqueados ocupam as vagas que sobraram: orçamento ocioso não é
-- economia. E se não houver bloqueado nenhum, a reserva simplesmente não
-- existe e as 25 vagas são uma fila só -- é o que acontece sozinho no dia em
-- que a gestão religar a etapa, sem ninguém editar SQL.
--
-- POR QUE NÃO (b), EXCLUIR DO `WHERE` ENQUANTO A ETAPA ESTIVER DESLIGADA.
-- Porque repetiria, com outra roupa, o defeito que a PR #722 corrigiu: um
-- predicado de exclusão cuja liberação depende de um campo que SÓ o caminho
-- excluído atualiza. Lá era `ultima_tentativa_em`, reescrito por um gatilho.
-- Aqui seria o `motivo`: `pagamento_conciliar_um` o regrava a cada tentativa
-- (`on conflict ... do update set motivo = excluded.motivo`), e só a cada
-- tentativa. Excluído do lote, o pagamento nunca mais é tentado; não sendo
-- tentado, o motivo congela no texto de hoje; e o texto de hoje é o que
-- mantém a exclusão. Isso não é teoria: o motivo real dessas 265 é
--
--   "boleto 50741510001 nao existe em parcelas e o acordo 074151 nao esta no
--    CRM | a API oficial ainda nao foi consultada para este caso"
--
-- -- ou seja, a saída real delas é O ACORDO ENTRAR NO CRM (pela importação do
-- relatório de acordos ou pelo registro da gestão), o que acontece SEM que a
-- etapa seja religada. Com (b), no dia em que o acordo entrasse, a rodada
-- nunca olharia de novo. A pendência ficaria congelada para sempre.
--
-- POR QUE NÃO (a), DESPRIORIZAR NO `ORDER BY`. Com 150 pendências com saída e
-- lote 25, as 150 nunca se esgotam dentro de uma rodada: o grupo de trás
-- nunca é alcançado. Na prática (a) É (b) -- zero avaliações por dia para as
-- 265 --, com o agravante de ser silenciosa: nada no retorno da rodada diria
-- que uma categoria inteira parou de ser olhada. A reserva é a mesma ideia com
-- um piso explícito e medido.
--
-- ===========================================================================
-- O CONTADOR DE TENTATIVAS FICA COMO ESTÁ -- decisão separada, e é "não mexer"
-- ===========================================================================
--
-- `_fila_pagamento_tentativa()` conta TOQUES, não tentativas de resolução:
-- qualquer UPDATE de linha com `decisao is null` faz `ultima_tentativa_em :=
-- now()` e incrementa o contador. Esta migration NÃO altera esse gatilho.
--
--   1. O gatilho não tem como saber a intenção de quem escreve -- vê OLD e
--      NEW, e nada mais. Distinguir exigiria que todo escritor declarasse
--      intenção (um GUC, uma coluna); o escritor que esquecesse pararia de
--      contar EM SILÊNCIO, e o `order by` da rodada depende desse campo.
--   2. Para o que a rodada usa o campo, TOQUE É A GRANDEZA CERTA: ele é
--      cursor de rodízio ("há quanto tempo alguém olhou esta linha"), não
--      medida de esforço. Trocar a semântica mudaria a rotação de um jeito
--      que ninguém mediu.
--   3. O sinal de "houve consulta de verdade" já existe como coluna:
--      `consulta_portador_em` -- nula em 329 de 329.
--   4. A PR #737 já expõe a distinção onde ela é lida, renomeando a coluna
--      para `toques_na_linha` na view da triagem.
--
-- O que esta migration acrescenta é expor a distinção TAMBÉM no retorno da
-- rodada e no monitor: `processados_bloqueado`, `processados_com_saida` e
-- `reserva_bloqueado`. Observabilidade, sem mudança de semântica.
--
-- ===========================================================================
-- O QUE NÃO MUDA
-- ===========================================================================
--
-- Assinatura (os jobs 73/74/75 chamam com 5 argumentos e continuam válidos --
-- há portão conferindo que a função não ganhou uma segunda assinatura, o que
-- tornaria a chamada deles AMBÍGUA), lote, teto de 500, orçamento de tempo,
-- teto de 120 s, trava de concorrência, guarda de carga, `statement_timeout`
-- de 15 s, prévia revertida, isolamento de erro, indicadores, registro de
-- execução, fronteira de 14/09 (`status_conciliacao is not null`), o respeito
-- à decisão da gestão, e a ordem dentro de cada grupo -- que continua sendo
-- exatamente a de 21/10, inclusive a despriorização do veterano recém-tentado.
--
-- Reversível: supabase/rollbacks/20261023004500_fluxo_incremental_reserva_bloqueado.rollback.sql

-- ---------------------------------------------------------------------------
-- PORTÃO DE ENTRADA. Falha a migration em vez de duplicar a classificação.
-- ---------------------------------------------------------------------------
do $entrada$
begin
  if to_regclass('public.vw_fila_pagamento_triagem') is null then
    raise exception
      'RECUSADO: esta migration depende de public.vw_fila_pagamento_triagem, criada '
      'pela PR #737 (supabase/migrations/20261023000700_fila_pagamento_triagem.sql). '
      'Aplique aquela primeiro. Duplicar a classificacao aqui criaria duas '
      'definicoes de "bloqueado" que divergiriam no primeiro dia.';
  end if;

  -- A etapa bloqueadora tem de continuar vindo da CONFIGURACAO. Se a triagem
  -- passar a cravar o nome da etapa, a reserva congela no dia em que foi
  -- escrita e religar a etapa deixa de devolver as vagas sozinho.
  if position('fluxo_pagamentos_config' in
              pg_get_viewdef('public.vw_fila_pagamento_triagem'::regclass, true)) = 0 then
    raise exception
      'RECUSADO: vw_fila_pagamento_triagem parou de ler fluxo_pagamentos_config. '
      'A reserva so pode existir enquanto a classificacao vier da configuracao.';
  end if;

  -- A coluna que a rodada le precisa existir com esse nome.
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public'
                    and table_name = 'vw_fila_pagamento_triagem'
                    and column_name = 'categoria') then
    raise exception 'RECUSADO: vw_fila_pagamento_triagem nao expoe a coluna categoria.';
  end if;
end
$entrada$;

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
  -- A FRAÇÃO DO LOTE RESERVADA A QUEM ESTÁ SEM PORTA DE SAÍDA. Declarada aqui
  -- e não em parâmetro de propósito: acrescentar um 6º parâmetro criaria uma
  -- SEGUNDA assinatura e a chamada de 5 argumentos dos jobs 73/74/75 passaria
  -- a ser ambígua. Mudar a política de orçamento é decisão de gestão, e
  -- decisão de gestão passa por migration e revisão.
  v_reserva_pct constant int := 20;
  v_reserva    int;
  v_ini        timestamptz := clock_timestamp();
  v_prazo      timestamptz;
  v_email      text := coalesce(auth.jwt() ->> 'email','server');
  v_carga      jsonb;
  v_alvo       record;
  v_r          jsonb;
  v_st         text;
  v_conta      jsonb := '{}'::jsonb;
  v_proc       int := 0;
  v_proc_bloq  int := 0;
  v_proc_saida int := 0;
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

  -- A RESERVA, depois dos tetos do lote. Nunca toma o lote inteiro enquanto
  -- houver pendência com saída: com lote 1 ela é zero.
  v_reserva := greatest(1, (p_lote * v_reserva_pct) / 100);
  if v_reserva >= p_lote then v_reserva := greatest(p_lote - 1, 0); end if;

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
  for v_alvo in
    with marcado as (
      select p.id,
             p.data_pagamento,
             coalesce(f.quantidade_tentativas, 0)                      as toques,
             coalesce(f.ultima_tentativa_em, '-infinity'::timestamptz) as ultimo,
             -- SEM PORTA DE SAÍDA HOJE. Vem INTEIRA da triagem da PR #737, que
             -- cruza o motivo com `fluxo_pagamentos_config` EM TEMPO DE
             -- CONSULTA. Nenhum nome de etapa aparece nesta função -- há portão
             -- conferindo isso logo abaixo. Consequência desejada: religar a
             -- etapa esvazia este conjunto sozinho, a reserva deixa de existir
             -- e as vagas voltam para a fila única.
             --
             -- `in (subconsulta)` E NÃO `left join`, medido em produção em
             -- 22/10/2026 com EXPLAIN ANALYZE: a subconsulta não é
             -- correlacionada, então o planejador a executa UMA VEZ e consulta
             -- o resultado por hash -- 10,1 ms. Com `left join` numa CTE ele
             -- estima uma linha, escolhe nested loop e compara 415 × 265 =
             -- 109.710 pares -- 105,7 ms, e o custo cresce com o QUADRADO do
             -- número de pendências. Dez vezes mais caro hoje, e pior amanhã.
             p.id in (select t.pagamento_id
                        from public.vw_fila_pagamento_triagem t
                       where t.categoria = 'BLOQUEADO_ETAPA_DESATIVADA') as bloqueado
        from public.pagamentos p
        left join public.fila_pagamento_sem_vinculo f
               on f.pagamento_id = p.id and f.decisao is null
       -- A FRONTEIRA DE 14/09: NULL = anterior ao motor, invisível por decisão.
       where p.status_conciliacao is not null
         and p.status_conciliacao <> 'BAIXADO'
         -- o que a gestão já decidiu não volta sozinho
         and not exists (select 1 from public.fila_pagamento_sem_vinculo d
                          where d.pagamento_id = p.id and d.decisao is not null)
    ),
    -- Dentro de cada grupo, a ORDEM DE 21/10, inalterada: o veterano
    -- recém-tentado vai para o fim, nunca para fora.
    ordenado as (
      select m.*,
             row_number() over (
               partition by m.bloqueado
               order by (case when m.toques >= p_tentativas_max
                               and m.ultimo > now() - make_interval(hours => p_espera_horas)
                              then 1 else 0 end) asc,
                        m.toques asc,
                        m.ultimo asc,
                        m.data_pagamento asc,
                        m.id asc) as pos
        from marcado m
    ),
    conta as (
      select count(*) filter (where not m.bloqueado) as n_saida,
             count(*) filter (where     m.bloqueado) as n_bloq
        from marcado m
    ),
    vagas as (
      -- PISO, NÃO TETO: os bloqueados levam `v_reserva` vagas e também as que
      -- sobrarem quando houver menos pendências com saída do que o lote.
      select least(c.n_bloq, greatest(v_reserva, p_lote - c.n_saida)) as n_para_bloq
        from conta c
    )
    select o.id, o.bloqueado
      from ordenado o cross join vagas v
     where (not o.bloqueado and o.pos <= p_lote - v.n_para_bloq)
        or (    o.bloqueado and o.pos <= v.n_para_bloq)
     order by o.bloqueado asc, o.pos asc
  loop
    -- PROTEÇÃO 3 -- orçamento de tempo, conferido a cada pagamento.
    exit when clock_timestamp() >= v_prazo;

    if p_aplicar then
      begin
        v_r := public.pagamento_conciliar_um(v_alvo.id, true);
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
        v_r := public.pagamento_conciliar_um(v_alvo.id, false);
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
      if v_alvo.bloqueado then v_proc_bloq  := v_proc_bloq  + 1;
                          else v_proc_saida := v_proc_saida + 1; end if;
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
    -- A DISTINÇÃO EXPOSTA, em vez de escondida: quanto do lote foi para quem
    -- tem porta de saída e quanto para quem não tem.
    'processados_com_saida',  v_proc_saida,
    'processados_bloqueado',  v_proc_bloq,
    'reserva_bloqueado',      v_reserva,
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
  'nunca o exclui. Pendência cuja única saída depende de etapa DESLIGADA '
  '(classificada pela vw_fila_pagamento_triagem, que lê fluxo_pagamentos_config '
  'em tempo de consulta) continua na fila e continua sendo reexaminada, mas '
  'dentro de uma RESERVA de 20% do lote, em vez de consumir o orçamento todo; '
  'religar a etapa devolve as vagas sozinho. A decisão financeira é toda de '
  'pagamento_conciliar_um.';

-- ---------------------------------------------------------------------------
-- MONITORAMENTO. As três colunas novas vão no FIM, que é o que
-- `create or replace view` permite. `security_invoker` é reafirmado
-- explicitamente para que a opção posta em 20261021210208 não dependa do que
-- o `replace` preserva por conta própria.
-- ---------------------------------------------------------------------------
create or replace view public.vw_fluxo_pagamentos_monitor
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
       round(extract(epoch from (now() - e.rodou_em))/60)::int      as minutos_atras,
       -- Quanto do lote foi para quem tem porta de saída, quanto foi para quem
       -- não tem, e quantas vagas estavam reservadas. Nulo nas execuções
       -- anteriores a esta migration, que não gravavam as chaves.
       (e.resultado->>'processados_com_saida')::int                 as processados_com_saida,
       (e.resultado->>'processados_bloqueado')::int                 as processados_bloqueado,
       (e.resultado->>'reserva_bloqueado')::int                     as reserva_bloqueado
  from public.fluxo_pagamentos_execucoes e
 order by e.rodou_em desc;

comment on view public.vw_fluxo_pagamentos_monitor is
  'Monitor do fluxo de pagamentos: última execução, situação, processados, '
  'baixados, pendentes, erros e duração, mais a repartição do lote entre '
  'pendência com porta de saída e pendência bloqueada por etapa desligada. '
  'Uma linha por rodada.';

-- A opção e os privilégios de 20261021210208 são reafirmados: `create or
-- replace view` não é lugar para perder defesa em profundidade por omissão.
revoke all on public.vw_fluxo_pagamentos_monitor from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.vw_fluxo_pagamentos_monitor from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.vw_fluxo_pagamentos_monitor from service_role;
grant select on public.vw_fluxo_pagamentos_monitor to authenticated, service_role;

-- ============================================================================
-- PORTÃO DE SAÍDA. Falha a migration em vez de deixar a rodada mentir depois.
-- ============================================================================
do $guarda$
declare
  v_src text;
  v_n   int;
begin
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental';
  if v_n <> 1 then
    raise exception
      'RECUSADO: fluxo_pagamentos_incremental ficou com % assinaturas. Os jobs '
      '73/74/75 chamam com 5 argumentos e a chamada passaria a ser AMBIGUA.', v_n;
  end if;

  -- O CODIGO, SEM OS COMENTARIOS. Os comentarios do corpo CITAM
  -- `fluxo_pagamentos_config` para explicar de onde vem a classificacao -- e
  -- um portao que olhasse o texto cru acusaria a propria explicacao. O que
  -- importa e o que a funcao EXECUTA.
  v_src := regexp_replace(
             (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental'),
             '--.*$', '', 'gn');

  -- O bloqueio vem da CONFIGURACAO, nunca do nome da etapa cravado aqui.
  if position('consulta_portador' in v_src) > 0 then
    raise exception
      'RECUSADO: nome de etapa fixo no SQL da rodada. A classificacao de '
      'bloqueado tem de vir inteira da triagem, que le fluxo_pagamentos_config.';
  end if;
  -- A rodada nao le nem escreve a tabela de configuracao diretamente: se ela
  -- aparecer aqui, ou virou leitura duplicada ou virou escrita -- e escrever
  -- seria religar etapa, que esta proibido.
  if position('fluxo_pagamentos_config' in v_src) > 0 then
    raise exception
      'RECUSADO: a rodada passou a tocar fluxo_pagamentos_config diretamente. '
      'A configuracao e lida pela triagem, e NUNCA escrita pela rodada.';
  end if;
  if position('vw_fila_pagamento_triagem' in v_src) = 0 then
    raise exception 'RECUSADO: a rodada parou de ler a triagem e a reserva sumiu.';
  end if;

  -- Os tetos continuam de pe.
  if position('if p_lote > 500 then p_lote := 500; end if;' in v_src) = 0 then
    raise exception 'RECUSADO: o teto de 500 do lote saiu da rodada.';
  end if;
  if position('if p_segundos > 120 then p_segundos := 120; end if;' in v_src) = 0 then
    raise exception 'RECUSADO: o teto de 120 s do orcamento saiu da rodada.';
  end if;
  if position('p.status_conciliacao is not null' in v_src) = 0 then
    raise exception 'RECUSADO: a fronteira de 14/09 saiu do where da rodada.';
  end if;
  if position('pg_try_advisory_xact_lock' in v_src) = 0 then
    raise exception 'RECUSADO: a trava de concorrencia saiu da rodada.';
  end if;

  -- O lote continua fechado para quem nao deve.
  if has_function_privilege('anon',
       'public.fluxo_pagamentos_incremental(int,int,int,int,boolean)', 'EXECUTE') then
    raise exception 'RECUSADO: anon ganhou EXECUTE na rodada.';
  end if;
  if not has_function_privilege('authenticated',
       'public.fluxo_pagamentos_incremental(int,int,int,int,boolean)', 'EXECUTE') then
    raise exception 'RECUSADO: authenticated perdeu o EXECUTE e a tela nao roda a previa.';
  end if;

  -- O monitor continua so de leitura.
  if has_table_privilege('authenticated', 'public.vw_fluxo_pagamentos_monitor', 'DELETE')
     or has_table_privilege('authenticated', 'public.vw_fluxo_pagamentos_monitor', 'UPDATE') then
    raise exception 'RECUSADO: authenticated voltou a poder escrever no monitor.';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relname = 'vw_fluxo_pagamentos_monitor'
                    and array_to_string(c.reloptions, ',') like '%security_invoker=%') then
    raise exception 'RECUSADO: o monitor perdeu security_invoker no replace.';
  end if;
end
$guarda$;
