-- ROLLBACK · SAÍDA TERMINAL PARA A PENDÊNCIA DECIDIDA SEM EFEITO FINANCEIRO
-- =============================================================================
-- Reverte 20261024170000_conciliacao_saida_terminal.sql.
--
-- RECUSA FECHADA SE ALGUÉM JÁ FOI ENCERRADO. Este projeto não tem PITR: todo
-- rollback é reversão por SQL, e apagar um estado que já vale seria perder a
-- decisão. Se houver pagamento em ENCERRADO_SEM_EFEITO_FINANCEIRO, este arquivo
-- PARA e manda reverter o backfill primeiro (o `.rollback.sql` do backfill
-- devolve cada pagamento ao status exato que a auditoria registra).
-- =============================================================================

do $guarda$
declare v_n int;
begin
  select count(*) into v_n from public.pagamentos
   where status_conciliacao = 'ENCERRADO_SEM_EFEITO_FINANCEIRO';
  if v_n > 0 then
    raise exception
      'ROLLBACK RECUSADO: % pagamento(s) estao em ENCERRADO_SEM_EFEITO_FINANCEIRO. Reverta o backfill antes (supabase/aguardando_aprovacao/20261024170000_backfill_saida_terminal.rollback.sql).', v_n;
  end if;
end
$guarda$;

-- 1. o contador da rodada volta ao predicado original
select internal.patch_funcao_ancorada(
  'public',
  'fluxo_pagamentos_incremental',
  $novo$where p.status_conciliacao is not null and p.status_conciliacao <> 'BAIXADO'
     -- SAIDA TERMINAL (24/10/2026): quem ja foi encerrado sem efeito financeiro
     -- deixa de ser contado como pendente. So o CONTADOR muda; a selecao do
     -- lote acima continua identica.
     and p.status_conciliacao <> 'ENCERRADO_SEM_EFEITO_FINANCEIRO';$novo$,
  $ancora$where p.status_conciliacao is not null and p.status_conciliacao <> 'BAIXADO';$ancora$,
  1
);

-- 2. a função sai
drop function if exists public.conciliacao_encerrar_sem_efeito_financeiro(uuid, boolean);

-- 3. as duas views voltam ao corpo das migrations 20261023000700 e 20261023164204
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
  'sejam vistas. Nao alcanca os pagamentos com status_conciliacao nulo (fronteira de '
  '14/09). Acordo cancelado e contado, nunca acionado: a decisao vive na frente da PR #694. '
  'Medido em 22/10/2026: 448 pendencias, R$ 377.515,27.';

-- A view nao e porta de entrada. Ver o cabecalho: com o padrao
-- `security_invoker = false` ela leria como dona e passaria por cima do RLS.
revoke all on public.vw_fila_pagamento_triagem from public;
revoke all on public.vw_fila_pagamento_triagem from anon;
revoke all on public.vw_fila_pagamento_triagem from authenticated;
grant select on public.vw_fila_pagamento_triagem to service_role;
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
  t.motivo            as triagem_motivo,
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
  'Motivo reaproveitado de vw_fila_pagamento_triagem (#737). Somente leitura.';

-- A view lê `pagamentos` e `parcelas`, que têm RLS. `security_invoker` faz a
-- leitura usar a RLS de QUEM CHAMA em vez da do dono -- sem isto a view
-- contornaria a RLS das tabelas base.
alter view public.vw_importacao_conferencia set (security_invoker = true);

-- View nova HERDA os privilégios do schema public, incluindo escrita para
-- `authenticated`. Fechar é obrigatório, e é a mesma lição da view de
-- monitoramento da PR #722, onde esse furo foi aberto e corrigido.
-- `authenticated` NÃO recebe SELECT: o acesso é só pelas funções com portão,
-- igual à `vw_fila_pagamento_triagem` da #737.
revoke all on public.vw_importacao_conferencia from public;
revoke all on public.vw_importacao_conferencia from anon;
revoke all on public.vw_importacao_conferencia from authenticated;
grant select on public.vw_importacao_conferencia to service_role;

-- 4. o CHECK volta aos 8 valores originais
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
      'TITULO_ORIGINAL_LIQUIDADO'
    ])
  );

do $conferir$
declare v_n int;
begin
  select count(*) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = 'conciliacao_encerrar_sem_efeito_financeiro';
  if v_n <> 0 then
    raise exception 'ROLLBACK incompleto: a funcao ainda existe.';
  end if;

  select (length(p.prosrc) - length(replace(p.prosrc,
            'ENCERRADO_SEM_EFEITO_FINANCEIRO', ''))) into v_n
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fluxo_pagamentos_incremental';
  if coalesce(v_n, 0) <> 0 then
    raise exception 'ROLLBACK incompleto: a rodada ainda menciona o status terminal.';
  end if;

  raise notice 'Rollback da saida terminal concluido.';
end
$conferir$;
