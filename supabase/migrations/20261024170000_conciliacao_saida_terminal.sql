-- SAÍDA TERMINAL PARA A PENDÊNCIA JÁ DECIDIDA SEM EFEITO FINANCEIRO
-- =============================================================================
-- ETAPA 1 da frente de conciliação inteligente, autorizada em 24/10/2026.
--
-- O PROBLEMA, medido em produção em 24/10/2026 (somente leitura):
--
--   33 pagamentos (R$ 83.203,30) têm decisão registrada em
--   `fila_pagamento_sem_vinculo` e `status_conciliacao` AINDA pendente:
--
--     RESOLVIDO_AUTOMATICO  19   R$ 29.278,47   17–23/09   parcela apontando: 0
--     FEITO                  9   R$ 50.893,76      29/09   parcela apontando: 0
--     ENCERRADO_GESTAO       5   R$  3.031,07      18/09   parcela apontando: 0
--
--   A causa não é defeito: `conciliacao_feito` e `conciliacao_ja_paga_encerrar`
--   gravam a decisão na fila e na auditoria com `sem_efeito_financeiro: true`, e
--   NÃO tocam `pagamentos.status_conciliacao` -- por desenho, porque não há
--   dinheiro a mover. Só que não existe estado terminal para esse desfecho: o
--   pagamento fica decidido na fila e pendente no motor, para sempre. A tela o
--   esconde (predicado `decisao is not null`), a rodada o pula, e o indicador
--   continua contando. Os 19 `RESOLVIDO_AUTOMATICO` são exatamente o resultado
--   de `conciliacao_ja_paga_encerrar` ter rodado.
--
-- POR QUE ESTA É A PRIMEIRA ETAPA. Qualquer botão de encaminhamento que feche a
-- fila sem baixa produz MAIS limbo. As 46 pendências `ja_paga_conferir_e_encerrar`
-- que a triagem já declara acionáveis virariam 46 novos casos como os 33. A
-- saída terminal é pré-requisito, não acabamento.
--
-- O QUE ESTA MIGRATION FAZ
--   1. amplia o CHECK de `pagamentos.status_conciliacao` com UM valor novo;
--   2. cria `conciliacao_encerrar_sem_efeito_financeiro`, com portão de gestão,
--      que só move o pagamento depois de CONFERIR a decisão já registrada;
--   3. tira o terminal da triagem de pendências (`vw_fila_pagamento_triagem`);
--   4. dá ao terminal categoria própria na conferência por arquivo
--      (`vw_importacao_conferencia`), para o histórico NÃO desaparecer;
--   5. corrige o contador `pendentes` da rodada, por patch ancorado.
--
-- O QUE ESTA MIGRATION NÃO FAZ
--   - não altera parcela, acordo, título, saldo nem baixa -- a única escrita em
--     dado é uma coluna de controle de conciliação, num pagamento por chamada;
--   - não religa job nem `consulta_portador`;
--   - não muda a SELEÇÃO do lote da rodada (ver abaixo: não precisa);
--   - não executa backfill. Os 33 continuam onde estão. O script está em
--     `supabase/aguardando_aprovacao/20261024170000_backfill_saida_terminal.sql.pendente`
--     e exige autorização própria.
--
-- POR QUE A SELEÇÃO DA RODADA NÃO PRECISA MUDAR, e isso é conferido, não
-- suposto. Das 6 funções que tratam "qualquer status ≠ BAIXADO" como pendente,
-- 5 já excluem a linha decidida (`not exists (... f.decisao is not null)`):
-- `conciliacao_reprocessar`, `fluxo_pagamentos_incremental` (na seleção),
-- `parcela_paga_antes_apos_importar_acordos`,
-- `parcela_paga_antes_reconstruir_pendentes` e `parcela_paga_antes_previa`.
-- `projecao_nao_baixados` já classifica `decisao is not null` como 'DECIDIDA'
-- ANTES de olhar o status. Como o terminal só é alcançável por quem já tem
-- decisão na fila, nenhuma dessas seis passa a tratá-lo errado. A única exceção
-- é o CONTADOR da rodada, que não filtra decisão -- e é só ele que esta
-- migration encosta no fluxo automático. O mapa completo está em
-- `docs/CONCILIACAO-SAIDA-TERMINAL-2026-10-24.md`.
--
-- GATILHOS DE `pagamentos` NUM UPDATE DE `status_conciliacao`, conferidos em
-- 24/10/2026 com `pg_get_triggerdef`:
--   trg_pagamento_baixado_encerra_confirmacao  WHEN (new = 'BAIXADO' and old is
--     distinct from 'BAIXADO')  ->  NÃO dispara para o terminal;
--   trg_pagamento_matricula                    UPDATE OF dados  ->  não dispara;
--   trg_pagamento_nome_do_operador             UPDATE OF operador_*  -> não dispara;
--   trg_efetividade_invalidar_pagamentos       FOR EACH STATEMENT  ->  dispara e
--     invalida o cache da Efetividade, com guarda de exceção própria. É efeito
--     esperado de qualquer escrita em `pagamentos`, não efeito financeiro;
--   trg_audit (fn_audit_generic)               ->  dispara e grava o antes/depois.
--
-- ROLLBACK: supabase/rollbacks/20261024170000_conciliacao_saida_terminal.rollback.sql
--
-- ESTA MIGRATION NÃO FOI APLICADA EM PRODUÇÃO.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. O VALOR TERMINAL
-- -----------------------------------------------------------------------------
-- O nome carrega o próprio limite, como `BAIXA_REGISTRADA_CRM` carrega o dele:
-- diz que a PENDÊNCIA foi encerrada por decisão humana sem mover dinheiro.
-- NÃO afirma que o pagamento foi conferido no banco, nem que houve baixa.
alter table public.pagamentos
  drop constraint if exists pagamentos_status_conciliacao_valido;

alter table public.pagamentos
  add constraint pagamentos_status_conciliacao_valido
  check (
    status_conciliacao is null
    or status_conciliacao = any (array[
      'BAIXADO',
      'AGUARDANDO_ACORDO',
      'AGUARDANDO_AMARRACAO',
      'PARCELA_JA_PAGA',
      'REVISAO',
      'SEM_VINCULO',
      'ACORDO_CONFIRMADO_SEM_ESTRUTURA',
      'TITULO_ORIGINAL_LIQUIDADO',
      -- novo em 24/10/2026, Etapa 1 da conciliação inteligente
      'ENCERRADO_SEM_EFEITO_FINANCEIRO'
    ])
  );

-- -----------------------------------------------------------------------------
-- 2. A FUNÇÃO: a transição só acontece depois de CONFERIR
-- -----------------------------------------------------------------------------
-- TRÊS PROVAS, e a ausência de qualquer uma recusa com motivo nomeado:
--
--   a) decisão na fila, num VALOR CONHECIDO. `decisao is not null` seria frouxo:
--      um valor futuro que signifique "reprocessar" passaria. A allowlist tem os
--      três valores que existem em produção hoje (283 linhas decididas:
--      RESOLVIDO_AUTOMATICO 268, FEITO 9, ENCERRADO_GESTAO 6).
--
--   b) NENHUMA parcela apontando para este pagamento (`origem_baixa_ref`). Se há
--      parcela, o pagamento TEM baixa registrada e o destino certo é BAIXADO --
--      nunca este terminal. É a guarda de integridade, e vale medição: nos 33 de
--      hoje, zero têm parcela apontando.
--
--   c) rastro em `auditoria` daquela decisão como SEM EFEITO FINANCEIRO. É a
--      procedência: sem ela, não se sabe se a decisão nasceu de um caminho que
--      prometia não mexer em dinheiro. Medido: 32 dos 33 têm esse rastro; UM
--      `RESOLVIDO_AUTOMATICO` não tem auditoria nenhuma e, de propósito, será
--      RECUSADO -- um caso sem procedência é para uma pessoa olhar, não para
--      entrar no bolo.
--
-- `p_confirmar` default FALSE: a chamada crua devolve a prévia e não grava. É o
-- padrão de `conciliacao_ja_paga_encerrar`.
create or replace function public.conciliacao_encerrar_sem_efeito_financeiro(
  p_pagamento_id uuid,
  p_confirmar    boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_terminal constant text := 'ENCERRADO_SEM_EFEITO_FINANCEIRO';
  v_decisoes constant text[] := array['FEITO','RESOLVIDO_AUTOMATICO','ENCERRADO_GESTAO'];
  v_email  text;
  v_st     text;
  v_fila   record;
  v_parc   uuid;
  v_aud    boolean;
  v_antes  jsonb;
  v_n      int;
begin
  -- O PORTÃO RECUSA IDENTIDADE NULA. `coalesce(..., false)` em vez da chamada
  -- crua: `NULL and ...` avalia para NULL, que não é TRUE, o `if` não dispara e
  -- a função seguiria adiante com autoria nula. Lição da importação do
  -- Santander (PR #727/#728) e das sete SECURITY DEFINER (PR #729).
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Encerrar pendencia sem efeito financeiro e decisao da gestao.'
      using errcode = '42501';
  end if;

  select p.status_conciliacao into v_st
    from public.pagamentos p where p.id = p_pagamento_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'PAGAMENTO_NAO_ENCONTRADO',
                              'gravou', false);
  end if;

  -- IDEMPOTÊNCIA. Já terminal: devolve ok sem reescrever e sem auditar de novo.
  if v_st = v_terminal then
    return jsonb_build_object('ok', true, 'motivo', 'JA_ENCERRADO',
                              'status_conciliacao', v_st, 'gravou', false);
  end if;

  -- A FRONTEIRA DE 14/09 É RESPEITADA. `status_conciliacao` nulo são os 8.955
  -- pagamentos anteriores ao motor, fora de alcance por decisão da gestão. Dar
  -- a eles um estado terminal aqui seria decidir no lugar dela.
  if v_st is null then
    return jsonb_build_object('ok', false, 'motivo', 'FORA_DA_JANELA',
                              'gravou', false);
  end if;
  if v_st = 'BAIXADO' then
    return jsonb_build_object('ok', false, 'motivo', 'JA_BAIXADO',
                              'status_conciliacao', v_st, 'gravou', false);
  end if;

  -- (a) a decisão registrada na fila
  select f.decisao, f.conclusao, f.decidido_por, f.decidido_em, f.motivo
    into v_fila
    from public.fila_pagamento_sem_vinculo f
   where f.pagamento_id = p_pagamento_id;
  if not found or v_fila.decisao is null or v_fila.decidido_em is null then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_DECISAO_VALIDA',
                              'detalhe', 'a fila nao tem decisao com data para este pagamento',
                              'gravou', false);
  end if;
  if not (v_fila.decisao = any (v_decisoes)) then
    return jsonb_build_object('ok', false, 'motivo', 'DECISAO_FORA_DA_ALLOWLIST',
                              'decisao', v_fila.decisao, 'gravou', false);
  end if;

  -- (b) nenhuma parcela aponta para este pagamento
  select pa.id into v_parc
    from public.parcelas pa
   where pa.origem_baixa_ref = p_pagamento_id::text
   limit 1;
  if v_parc is not null then
    return jsonb_build_object('ok', false, 'motivo', 'TEM_BAIXA_REGISTRADA',
                              'detalhe', 'existe parcela apontando para este pagamento; o destino e BAIXADO',
                              'parcela_id', v_parc, 'gravou', false);
  end if;

  -- (c) a procedência: decisão auditada como sem efeito financeiro
  select exists (
           select 1 from public.auditoria au
            where au.registro_id = p_pagamento_id
              and au.tabela_afetada = 'fila_pagamento_sem_vinculo'
              and (au.detalhes ->> 'sem_efeito_financeiro')::boolean is true)
    into v_aud;
  if not v_aud then
    return jsonb_build_object('ok', false, 'motivo', 'SEM_PROVA_DE_DECISAO_SEM_EFEITO',
                              'detalhe', 'a decisao nao tem rastro de auditoria sem efeito financeiro',
                              'gravou', false);
  end if;

  v_antes := jsonb_build_object(
    'status_conciliacao', v_st,
    'conciliacao_motivo', (select p.conciliacao_motivo from public.pagamentos p
                            where p.id = p_pagamento_id),
    'fila', jsonb_build_object('decisao', v_fila.decisao, 'conclusao', v_fila.conclusao,
                               'decidido_por', v_fila.decidido_por,
                               'decidido_em', v_fila.decidido_em,
                               'motivo', v_fila.motivo));

  if not coalesce(p_confirmar, false) then
    return jsonb_build_object('ok', true, 'modo', 'SIMULACAO', 'gravou', false,
                              'aprovado', true, 'estado_anterior', v_antes,
                              'status_proposto', v_terminal);
  end if;

  -- duas chamadas ao mesmo tempo: a segunda espera e, ao reler, é recusada
  perform pg_advisory_xact_lock(
    hashtextextended('conciliacao_saida_terminal:' || p_pagamento_id::text, 0));

  -- A ÚNICA ESCRITA EM DADO. `conciliacao_motivo` NÃO é tocado: o texto que
  -- explica por que a pendência existiu é histórico e fica onde está. O que a
  -- transição significa vai para a auditoria, que é onde "o que mudou e por
  -- quem" pertence.
  --
  -- O `and status_conciliacao = v_st` é concorrência otimista: se outra
  -- transação mudou o status entre a conferência e aqui, nenhuma linha casa e a
  -- função aborta em vez de escrever sobre decisão alheia.
  update public.pagamentos
     set status_conciliacao = v_terminal
   where id = p_pagamento_id
     and status_conciliacao = v_st;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'SAIDA_TERMINAL_ABORTADA: o status do pagamento mudou durante a transicao (% linhas)', v_n;
  end if;

  v_email := coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao');
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (v_email, 'CONCILIACAO_SAIDA_TERMINAL', 'pagamentos', p_pagamento_id,
          jsonb_build_object('pagamento_id', p_pagamento_id,
                             'estado_anterior', v_antes,
                             'status_conciliacao', v_terminal,
                             'decisao_que_autorizou', v_fila.decisao,
                             'sem_efeito_financeiro', true));

  return jsonb_build_object('ok', true, 'modo', 'CONFIRMADO', 'gravou', true,
                            'pagamento_id', p_pagamento_id,
                            'status_conciliacao', v_terminal,
                            'estado_anterior', v_antes);
end;
$function$;

comment on function public.conciliacao_encerrar_sem_efeito_financeiro(uuid, boolean) is
  'Move o pagamento para ENCERRADO_SEM_EFEITO_FINANCEIRO apenas quando ja existe '
  'decisao na fila (FEITO / RESOLVIDO_AUTOMATICO / ENCERRADO_GESTAO), NENHUMA parcela '
  'aponta para ele e a auditoria registra a decisao como sem efeito financeiro. '
  'Portao de gestao, idempotente, p_confirmar=false devolve previa. Nao toca parcela, '
  'acordo, titulo, saldo nem baixa. Nao afirma pagamento conferido no banco.';

-- O portão vive DENTRO da função; `authenticated` recebe EXECUTE como as demais
-- funções leitoras/decisoras desta frente. `anon` e `public`, nunca.
revoke all on function public.conciliacao_encerrar_sem_efeito_financeiro(uuid, boolean) from public;
revoke all on function public.conciliacao_encerrar_sem_efeito_financeiro(uuid, boolean) from anon;
grant execute on function public.conciliacao_encerrar_sem_efeito_financeiro(uuid, boolean) to authenticated;
grant execute on function public.conciliacao_encerrar_sem_efeito_financeiro(uuid, boolean) to service_role;

-- -----------------------------------------------------------------------------
-- 3. A TRIAGEM DE PENDÊNCIAS DEIXA DE VER O TERMINAL
-- -----------------------------------------------------------------------------
-- Corpo reproduzido da migration 20261023000700 (#737) com UMA linha somada na
-- CTE `base`, e nada mais. A classificação vive neste corpo: o diff foi gerado
-- do arquivo versionado, não redigitado -- a lição da #748.
create or replace view public.vw_fila_pagamento_triagem as
with cfg as (
  select etapa, ligado from public.fluxo_pagamentos_config
),
-- O MAPA. Uma linha por dependencia conhecida entre o texto do motivo e a etapa
-- que resolveria o caso. Fica aqui, visivel e auditavel, em vez de espalhado
-- dentro do CASE. Crescer este mapa e a forma de cobrir uma etapa nova.
_dependencia as (
  select * from (values
    ('%API oficial ainda nao foi consultada%', 'consulta_portador')
  ) as d(padrao_motivo, etapa)
),
base as (
  select
    p.id                     as pagamento_id,
    p.aluno_id,
    p.data_pagamento,
    p.valor_pago,
    p.status_conciliacao,
    p.titulo_numero,
    f.id                     as fila_id,
    f.boleto,
    f.motivo,
    f.sugestoes,
    f.decisao,
    f.decidido_por,
    f.decidido_em,
    f.consulta_portador_em,
    f.primeira_tentativa_em,
    f.quantidade_tentativas
  from public.pagamentos p
  -- Sem condicao de `decisao` no JOIN: e justamente a linha decidida que
  -- precisa chegar aqui para que os 33 sejam vistos.
  left join public.fila_pagamento_sem_vinculo f
         on f.pagamento_id = p.id
  -- A FRONTEIRA DE 14/09 E RESPEITADA. `status_conciliacao is not null` deixa
  -- de fora os 8.955 pagamentos historicos (R$ 12.306.066,08, 01/07 a 11/09),
  -- exatamente como `fluxo_pagamentos_incremental` faz. Esta view nao os
  -- classifica nem os conta: eles seguem sendo decisao da gestao, nao efeito
  -- colateral de uma triagem.
  where p.status_conciliacao is not null
    and p.status_conciliacao <> 'BAIXADO'
    -- SAIDA TERMINAL (24/10/2026). O pagamento ja decidido sem efeito financeiro
    -- nao e pendencia: sai da triagem. O historico dele continua visivel na
    -- conferencia por arquivo, na fila e na auditoria -- ver a categoria propria
    -- em vw_importacao_conferencia. Sem esta linha, a subcategoria
    -- 'decidida_mas_ainda_pendente' seguiria contando quem ja tem saida.
    and p.status_conciliacao <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO'
),
classificado as (
  select
    b.*,
    -- A etapa desligada que explica a parada, quando ha uma. Calculada antes do
    -- CASE para nao repetir a subconsulta, e exposta como coluna propria: a tela
    -- precisa dizer O NOME da etapa, nao so que "esta bloqueado".
    (select d.etapa
       from _dependencia d
       join cfg c on c.etapa = d.etapa
      where b.motivo ilike d.padrao_motivo
        and c.ligado is false
        and b.consulta_portador_em is null
      limit 1) as etapa_desligada
  from base b
),
final as (
  select
    c.*,
    case
      -- 1. Pendente sem nenhuma linha na fila. Hoje sao 0 em producao, mas e
      --    estado possivel, e cair no balde residual mudo seria pior.
      when c.fila_id is null
        then 'CONFERENCIA_HUMANA'
      -- 2. Decidida e ainda pendente: a contradicao que ninguem ve.
      when c.decisao is not null
        then 'CONFERENCIA_HUMANA'
      -- 3. Acordo cancelado: frente da PR #694, sem acao nova aqui.
      when c.motivo ilike '%CANCELADO, nao ATIVO%'
        then 'CONFERENCIA_HUMANA'
      -- 4. Dado estruturado: existe sugestao de aluno para a pessoa escolher.
      when jsonb_array_length(coalesce(c.sugestoes, '[]'::jsonb)) > 0
        then 'ACIONAVEL_ADMINISTRATIVO'
      -- 5. Parcela ja paga antes: a etapa `encerrar_ja_paga_conferida` esta
      --    ligada e existe para isto; a conferencia e humana, a acao existe.
      when c.motivo ilike '%ja estava PAGO antes%'
        then 'ACIONAVEL_ADMINISTRATIVO'
      -- 6. Parada por etapa desligada -- pela configuracao, nao pelo nome fixo.
      when c.etapa_desligada is not null
        then 'BLOQUEADO_ETAPA_DESATIVADA'
      -- 7. Falta a estrutura do acordo, e a consulta nao esta bloqueada.
      when c.motivo ilike '%nao esta no CRM%'
        then 'AGUARDANDO_INFORMACAO_ACORDO'
      else 'CONFERENCIA_HUMANA'
    end as categoria,
    case
      when c.fila_id is null                            then 'pendente_sem_linha_na_fila'
      when c.decisao is not null                        then 'decidida_mas_ainda_pendente'
      when c.motivo ilike '%CANCELADO, nao ATIVO%'      then 'acordo_cancelado_fluxo_proprio'
      when jsonb_array_length(coalesce(c.sugestoes, '[]'::jsonb)) > 0
                                                        then 'escolher_aluno_sugerido'
      when c.motivo ilike '%ja estava PAGO antes%'      then 'ja_paga_conferir_e_encerrar'
      when c.etapa_desligada is not null                then c.etapa_desligada
      when c.motivo ilike '%nao esta no CRM%'           then 'acordo_ausente_no_crm'
      -- A marca `PARCELA_PAGA_ANTES_*` e prefixo do motivo e vem ANTES de
      -- "nao tem parcela livre", que esse mesmo texto tambem contem: o sinal
      -- mais especifico e o que ajuda quem vai conferir.
      when c.motivo ilike '%PARCELA_PAGA_ANTES%'        then 'parcela_paga_antes_da_extracao'
      when c.motivo ilike '%nao tem parcela livre%'     then 'acordo_sem_parcela_livre'
      when c.motivo ilike '%fora da faixa aceita%'      then 'valor_fora_da_faixa'
      -- Nao e erro de um mes. Conferido caso a caso em 22/10/2026 nos tres
      -- unicos: o vencimento do arquivo aponta para a parcela ANTERIOR, porque
      -- os 4 ultimos digitos do boleto sao sequencia de EMISSAO da ULBRA e nao
      -- indice de `parcelas.numero`. Quando uma parcela e reemitida, a
      -- sequencia avanca e o vencimento continua no da parcela antiga. Detalhe
      -- em docs/TRIAGEM-FILA-PAGAMENTO-2026-10-22.md.
      when c.motivo ilike '%nao bate com a parcela%'    then 'boleto_reemitido_vencimento_anterior'
      else 'nao_classificado'
    end as subcategoria
  from classificado c
)
select
  f.pagamento_id,
  f.aluno_id,
  f.data_pagamento,
  f.valor_pago,
  f.status_conciliacao,
  f.titulo_numero,
  f.boleto,
  f.categoria,
  f.subcategoria,
  f.etapa_desligada,
  -- A ACAO SUGERIDA E DECLARADA, NUNCA GENERICA. Fora destas duas, nula: a tela
  -- oferece abrir a ficha e nada mais. Uma acao generica que editasse valor ou
  -- status final atuaria fora da origem do dado, sem historico e sem auditoria.
  case f.subcategoria
    when 'escolher_aluno_sugerido'     then 'ESCOLHER_ALUNO'
    when 'ja_paga_conferir_e_encerrar' then 'CONFERIR_E_ENCERRAR'
    else null
  end as acao_sugerida,
  f.motivo,
  f.sugestoes,
  f.decisao,
  f.decidido_por,
  f.decidido_em,
  -- `quantidade_tentativas` CONTA TOQUES, NAO TENTATIVAS DE RESOLUCAO.
  -- `_fila_pagamento_tentativa()` e BEFORE INSERT OR UPDATE e, em qualquer
  -- UPDATE de linha com `decisao is null`, faz `ultima_tentativa_em := now()` e
  -- incrementa o contador. A rodada reencosta na linha de hora em hora, e o
  -- numero cresce com o calendario. Para as 265 bloqueadas o numero de consultas
  -- de fato tentadas e ZERO -- `consulta_portador_em` e nulo em todas --, nao
  -- 229. O nome da coluna diz isso para quem le a tela.
  f.quantidade_tentativas as toques_na_linha,
  f.primeira_tentativa_em,
  f.consulta_portador_em
from final f;

comment on view public.vw_fila_pagamento_triagem is
  'Triagem das pendencias de conciliacao em 4 categorias (ACIONAVEL_ADMINISTRATIVO, '
  'AGUARDANDO_INFORMACAO_ACORDO, BLOQUEADO_ETAPA_DESATIVADA, CONFERENCIA_HUMANA). '
  'SOMENTE LEITURA, zero DML. Uma linha por pagamento pendente, garantida pelo indice '
  'unico fila_pag_sem_vinculo_unico. A etapa bloqueadora vem de fluxo_pagamentos_config '
  'em tempo de consulta: religar a etapa reclassifica sozinho. Nao herda o predicado '
  'que esconde as linhas ja decididas, para que as pendencias decididas-mas-pendentes '
  'sejam vistas -- EXCETO as que ja receberam a saida terminal '
  'ENCERRADO_SEM_EFEITO_FINANCEIRO (24/10/2026), que deixam de ser pendencia e seguem '
  'visiveis em vw_importacao_conferencia, na fila e na auditoria. Nao alcanca os '
  'pagamentos com status_conciliacao nulo (fronteira de 14/09). Acordo cancelado e '
  'contado, nunca acionado: a decisao vive na frente da PR #694.';

-- A view nao e porta de entrada: com `security_invoker = false` (o padrao) ela
-- leria como DONA e passaria por cima do RLS de `pagamentos`. Reafirmado aqui
-- porque `create or replace view` preserva os grants, e reafirmar e barato.
revoke all on public.vw_fila_pagamento_triagem from public;
revoke all on public.vw_fila_pagamento_triagem from anon;
revoke all on public.vw_fila_pagamento_triagem from authenticated;
grant select on public.vw_fila_pagamento_triagem to service_role;

-- -----------------------------------------------------------------------------
-- 4. A CONFERÊNCIA POR ARQUIVO GANHA A CATEGORIA, para o histórico não sumir
-- -----------------------------------------------------------------------------
-- A invariante desta view é "as categorias fecham com o arquivo": todo pagamento
-- do arquivo aparece, em exatamente uma categoria. Tirar o terminal daqui
-- quebraria o fechamento e esconderia dinheiro. Então ele ganha categoria
-- PRÓPRIA, logo depois de BAIXA_REGISTRADA_CRM e ANTES de FORA_DA_JANELA e dos
-- ramos da triagem -- que para ele devolvem nulo, porque ele saiu da triagem.
--
-- E o MOTIVO do terminal passa a recuar para `f.motivo`: fora da triagem,
-- `t.motivo` é nulo, e o texto que explica a pendência original continua na
-- própria fila. Sem esse recuo, a linha encerrada apareceria sem motivo nenhum
-- na tela -- que é justamente o histórico que esta etapa precisa manter. O
-- recuo é CONDICIONADO ao terminal, para não mudar nenhuma outra categoria.
--
-- Corpo reproduzido da migration 20261023164204 (#746) com essas duas mudanças,
-- e nada mais.
create or replace view public.vw_importacao_conferencia as
select
  -- o arquivo
  p.importacao_id,
  i.arquivo_nome,
  i.tipo              as importacao_tipo,
  i.status            as importacao_status,
  i.created_at        as importado_em,
  i.usuario           as importado_por,

  -- o pagamento
  p.id                as pagamento_id,
  p.data_pagamento,
  p.valor_pago,
  p.valor_honorario,
  p.aluno_id,
  p.aluno_nome,
  p.matricula,
  p.cpf,
  p.titulo_numero,
  p.numero_parcela_completo,
  p.operador_email,
  p.operador_nome,

  -- o veredito do motor, e COMO o vínculo nasceu (a origem do pagamento)
  p.status_conciliacao,
  p.conciliacao_motivo,
  p.origem_vinculo,
  p.origem_vinculo_ref,

  -- A EVIDÊNCIA da baixa registrada no CRM. Sem isto a tela afirmaria "baixado"
  -- sem poder mostrar o que sustenta.
  pa.id               as parcela_baixada_id,
  pa.origem_baixa     as baixa_origem,
  pa.origem_baixa_em  as baixa_em,

  -- O MOTIVO, reaproveitado da triagem da #737
  t.categoria         as triagem_categoria,
  t.subcategoria      as triagem_subcategoria,
  -- O RECUO VALE SÓ PARA O TERMINAL. Um `coalesce` cru mudaria também as linhas
  -- BAIXA_REGISTRADA_CRM que têm fila já resolvida (em produção são 246): elas
  -- hoje mostram motivo vazio e passariam a mostrar o motivo antigo da fila --
  -- mudança visível numa categoria que esta etapa não tem motivo para tocar.
  case when p.status_conciliacao = 'ENCERRADO_SEM_EFEITO_FINANCEIRO'
       then coalesce(t.motivo, f.motivo)
       else t.motivo
  end                 as triagem_motivo,
  t.acao_sugerida,

  -- Duplicidade como SINAL, não como categoria (ver nota 5)
  (d.pagamento_id is not null) as tem_suspeita_duplicidade,

  -- A fila: viva ou já resolvida, e de qual arquivo ela é
  f.id                as fila_id,
  f.importacao_id     as fila_importacao_id,
  f.arquivo_nome      as fila_arquivo_nome,
  (f.id is not null and f.conclusao is null and f.decisao is null) as fila_aberta,
  -- Pendência detectada por OUTRO arquivo: é o fenômeno dos 115. Serve para a
  -- tela separar "problema deste arquivo" de "pendência histórica reencostada".
  (f.id is not null and f.importacao_id is distinct from p.importacao_id) as fila_de_outro_arquivo,

  -- A CATEGORIA EXCLUSIVA. Ordem de prioridade, não alfabética: primeiro o que
  -- tem prova de registro, depois o que está fora da janela por decisão, e só
  -- então os recortes de pendência vindos da triagem.
  case
    when pa.id is not null                                  then 'BAIXA_REGISTRADA_CRM'
    when p.status_conciliacao = 'ENCERRADO_SEM_EFEITO_FINANCEIRO'
                                                            then 'ENCERRADO_SEM_EFEITO_FINANCEIRO'
    when p.status_conciliacao is null                       then 'FORA_DA_JANELA'
    when t.categoria = 'CONFERENCIA_HUMANA'                 then 'DIVERGENCIA'
    when t.categoria = 'AGUARDANDO_INFORMACAO_ACORDO'       then 'SEM_VINCULO'
    when t.categoria in ('ACIONAVEL_ADMINISTRATIVO',
                         'BLOQUEADO_ETAPA_DESATIVADA')      then 'BAIXA_PENDENTE'
    -- Medido ZERO hoje. Fica como ramo honesto em vez de forçar o pagamento
    -- numa categoria que não foi apurada: se aparecer, a tela mostra e alguém
    -- investiga, em vez de o número somar no lugar errado.
    else 'NAO_CLASSIFICADO'
  end as categoria

from public.pagamentos p
join public.importacoes i
  on i.id = p.importacao_id
-- 1 para 1 estrito, medido: não multiplica linha
left join public.parcelas pa
  on pa.origem_baixa_ref = p.id::text
left join public.fila_pagamento_sem_vinculo f
  on f.pagamento_id = p.id
left join public.vw_fila_pagamento_triagem t
  on t.pagamento_id = p.id
left join public.pagamento_suspeita_duplicidade d
  on d.pagamento_id = p.id;

comment on view public.vw_importacao_conferencia is
  'Conferencia por arquivo importado: uma linha por pagamento, categoria exclusiva. '
  'Chave do arquivo = pagamentos.importacao_id (NAO a da fila: 115 linhas divergem). '
  'BAIXA_REGISTRADA_CRM = existe parcela apontando (origem_baixa_ref), nunca status PAGO. '
  'ENCERRADO_SEM_EFEITO_FINANCEIRO (24/10/2026) = a pendencia foi encerrada por decisao '
  'humana sem mover dinheiro; sai da triagem e fica aqui, para o historico nao desaparecer. '
  'Motivo reaproveitado de vw_fila_pagamento_triagem (#737), com recuo para o motivo da '
  'propria fila quando o pagamento ja saiu da triagem. Somente leitura.';

-- `security_invoker` faz a leitura usar a RLS de QUEM CHAMA, nao a do dono.
alter view public.vw_importacao_conferencia set (security_invoker = true);

revoke all on public.vw_importacao_conferencia from public;
revoke all on public.vw_importacao_conferencia from anon;
revoke all on public.vw_importacao_conferencia from authenticated;
grant select on public.vw_importacao_conferencia to service_role;

-- -----------------------------------------------------------------------------
-- 5. O CONTADOR `pendentes` DA RODADA PARA DE CONTAR QUEM JÁ TEM SAÍDA
-- -----------------------------------------------------------------------------
-- É O ÚNICO PONTO EM QUE ESTA MIGRATION ENCOSTA NO FLUXO AUTOMÁTICO, e é um
-- INDICADOR, não um comportamento: a expressão trocada só CONTA. A seleção do
-- lote, os tetos, a trava, a espera, a reserva e tudo o que a rodada DECIDE
-- ficam byte a byte como estão -- e a seleção não precisa mudar, porque já
-- exclui `decisao is not null` e o terminal só é alcançável por quem tem
-- decisão (ver o cabeçalho).
--
-- Sem esta troca, `fluxo_pagamentos_execucoes.resultado->>'pendentes'`
-- continuaria publicando os encerrados como pendentes -- o relatório oficial
-- da rodada mentiria exatamente no ponto que esta etapa existe para corrigir.
--
-- PATCH ANCORADO, sem corpo retypado: `internal.patch_funcao_ancorada` lê
-- `pg_get_functiondef`, exige a âncora UMA vez e recria. Se produção mudar
-- nesse trecho, a migration FALHA em vez de reescrever a função errada. A
-- âncora foi colhida em 24/10/2026 contra o corpo vivo
-- (md5(prosrc) = 11c14ef5bcbc4283357de8ef2d798c5e, 6.761 caracteres,
-- 1 ocorrência), o mesmo md5 que o repositório já reproduz e que o teste
-- `fluxo_incremental_reserva_bloqueado` fixa como MD5_RODADA_PROD.
select internal.patch_funcao_ancorada(
  'public',
  'fluxo_pagamentos_incremental',
  $ancora$where p.status_conciliacao is not null and p.status_conciliacao <> 'BAIXADO';$ancora$,
  $novo$where p.status_conciliacao is not null and p.status_conciliacao <> 'BAIXADO'
     -- SAIDA TERMINAL (24/10/2026): quem ja foi encerrado sem efeito financeiro
     -- deixa de ser contado como pendente. So o CONTADOR muda; a selecao do
     -- lote acima continua identica.
     and p.status_conciliacao <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO';$novo$,
  1
);

-- -----------------------------------------------------------------------------
-- 6. OS PORTÕES. Se um deles não fecha, a migration falha e nada fica meio feito
-- -----------------------------------------------------------------------------
do $portao$
declare v_n int; v_ok boolean;
begin
  -- 6.1 o CHECK aceita o valor novo e continua recusando o que não existe
  begin
    perform 1 from public.pagamentos limit 0;
    v_ok := (select true from pg_constraint c join pg_class t on t.oid = c.conrelid
              where t.relname = 'pagamentos'
                and c.conname = 'pagamentos_status_conciliacao_valido'
                and pg_get_constraintdef(c.oid) like '%ENCERRADO\_SEM\_EFEITO\_FINANCEIRO%');
  exception when others then v_ok := false;
  end;
  if not coalesce(v_ok, false) then
    raise exception 'PORTAO 6.1: o CHECK de status_conciliacao nao aceita ENCERRADO_SEM_EFEITO_FINANCEIRO.';
  end if;

  -- 6.2 a função existe, é SECURITY DEFINER e tem search_path fixo
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'conciliacao_encerrar_sem_efeito_financeiro'
     and p.prosecdef
     and array_to_string(coalesce(p.proconfig, '{}'), ',') like '%search_path%';
  if v_n <> 1 then
    raise exception 'PORTAO 6.2: conciliacao_encerrar_sem_efeito_financeiro nao esta SECURITY DEFINER com search_path (% encontradas).', v_n;
  end if;

  -- 6.3 o contador da rodada recebeu o predicado, exatamente uma vez
  select (length(p.prosrc) - length(replace(p.prosrc,
            $x$and p.status_conciliacao <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO';$x$, '')))
         / length($x$and p.status_conciliacao <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO';$x$)
    into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental';
  if coalesce(v_n, 0) <> 1 then
    raise exception 'PORTAO 6.3: o contador da rodada tem % ocorrencia(s) do predicado novo, esperado 1.', coalesce(v_n, 0);
  end if;

  -- 6.4 a SELEÇÃO do lote segue intacta: o predicado novo NÃO entrou nela.
  -- A seleção é a única parte da rodada que decide; se o patch tivesse caído
  -- lá, a rodada mudaria de comportamento. Prova pelo texto: o predicado novo
  -- aparece DEPOIS de `select count(*) into v_pend`.
  select case when position($y$and p.status_conciliacao <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO';$y$ in p.prosrc)
                 > position($y$select count(*) into v_pend$y$ in p.prosrc)
              then true else false end
    into v_ok
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental';
  if not coalesce(v_ok, false) then
    raise exception 'PORTAO 6.4: o predicado novo nao esta no contador -- pode ter caido na selecao do lote.';
  end if;

  -- 6.5 a triagem não devolve nenhuma linha com o terminal
  select count(*) into v_n from public.vw_fila_pagamento_triagem
   where status_conciliacao = 'ENCERRADO_SEM_EFEITO_FINANCEIRO';
  if v_n <> 0 then
    raise exception 'PORTAO 6.5: a triagem ainda devolve % linha(s) com o status terminal.', v_n;
  end if;

  -- 6.6 a conferência por arquivo conhece a categoria
  select count(*) into v_n
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'vw_importacao_conferencia'
     and pg_get_viewdef(c.oid) like '%ENCERRADO\_SEM\_EFEITO\_FINANCEIRO%';
  if v_n <> 1 then
    raise exception 'PORTAO 6.6: vw_importacao_conferencia nao traz a categoria terminal.';
  end if;

  -- 6.7 ESTA MIGRATION NÃO MOVEU PAGAMENTO NENHUM. A função existe e ninguém a
  -- chamou: zero registros de transição na auditoria. O backfill dos 33 é passo
  -- separado, com autorização própria.
  select count(*) into v_n from public.auditoria
   where acao = 'CONCILIACAO_SAIDA_TERMINAL';
  if v_n <> 0 then
    raise exception 'PORTAO 6.7: ha % transicao(oes) registrada(s); esta migration nao deveria mover pagamento.', v_n;
  end if;

  raise notice 'Saida terminal: 7 portoes fechados. Nenhum pagamento movido.';
end
$portao$;
