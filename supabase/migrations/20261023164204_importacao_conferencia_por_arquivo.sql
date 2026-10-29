-- CONFERÊNCIA DE PAGAMENTOS POR ARQUIVO IMPORTADO
-- =============================================================================
-- O PROBLEMA, nas palavras da gestão: ao importar a planilha do Santander, as
-- divergências aparecem misturadas com pendências antigas, e não há como dizer
-- quais pagamentos DAQUELE arquivo foram baixados e quais continuam pendentes.
--
-- ESTRUTURAL, ZERO DML: cria uma view de leitura e duas funções de leitura.
-- Nenhum insert/update/delete, nenhuma coluna, gatilho, índice ou agendamento.
-- NÃO toca no motor de conciliação, em parcelas, acordos, baixas nem saldos.
--
-- -----------------------------------------------------------------------------
-- O QUE FOI MEDIDO ANTES DE ESCREVER (23/10/2026, produção, só leitura)
-- -----------------------------------------------------------------------------
-- 1. A CADEIA EXISTE E FECHA:
--      importacoes.id -> pagamentos.importacao_id -> pagamentos.id
--                     -> parcelas.origem_baixa_ref
--    1.322 pagamentos com status BAIXADO e 1.322 parcelas apontando de volta.
--    E o apontamento é 1 PARA 1 ESTRITO: 1.322 refs, 1.322 distintas, ZERO
--    pagamentos com duas parcelas. É isso que garante "uma linha por pagamento"
--    nesta view -- o join não pode multiplicar linha.
--
-- 2. A CHAVE DO ARQUIVO É `pagamentos.importacao_id`, NÃO a da fila.
--    Medido: 115 linhas de `fila_pagamento_sem_vinculo` têm `importacao_id`
--    DIFERENTE do `importacao_id` do próprio pagamento. A causa é o
--    `ON CONFLICT DO UPDATE` da RPC de importação, que reatribui o pagamento ao
--    arquivo NOVO quando ele é reimportado, enquanto a linha da fila guarda o
--    arquivo da detecção original. Filtrar a fila pelo `importacao_id` dela
--    atribuiria 115 pendências ao ARQUIVO ERRADO.
--
-- 3. NÃO HÁ DUPLICAÇÃO ENTRE CATEGORIAS, e isso é medido, não suposto.
--    Dos 1.322 baixados, 246 TÊM linha na fila -- mas ZERO com a fila ainda
--    aberta (`conclusao` e `decisao` nulos). Pagamento baixado nunca tem
--    pendência viva. Sem essa medição, uma tela com abas contaria o mesmo
--    pagamento em "baixa confirmada" e em "pendente".
--
-- 4. `FORA_DA_JANELA` NÃO É PENDÊNCIA, é fronteira de decisão da gestão.
--    8.955 pagamentos têm `status_conciliacao` nulo, e TODOS têm data anterior a
--    14/09/2026 -- a fronteira do motor. Do dia 14/09 em diante são 1.709
--    pagamentos com 100% de cobertura: zero sem status. Chamar os 8.955 de
--    "baixa pendente" seria inventar pendência onde houve decisão.
--
-- 5. DUPLICIDADE É SINALIZADOR, NÃO CATEGORIA. As 9 linhas de
--    `pagamento_suspeita_duplicidade` têm TODAS `status_conciliacao` nulo, ou
--    seja são pré-14/09. Como categoria exclusiva, ou ela teria prioridade e
--    puxaria 9 históricos para uma categoria atual, ou ficaria abaixo e NUNCA
--    dispararia (medido: zero). Então duplicidade vira a coluna booleana
--    `tem_suspeita_duplicidade`, visível sem contar duas vezes.
--
-- -----------------------------------------------------------------------------
-- A DISTINÇÃO QUE A GESTÃO PEDIU EXPLICITAMENTE
-- -----------------------------------------------------------------------------
-- `BAIXA_REGISTRADA_CRM` diz o que diz, e nada mais: existe uma parcela no CRM
-- apontando para este pagamento. NÃO é afirmação de pagamento bancário
-- comprovado -- a evidência bancária é o próprio arquivo do Santander, que é a
-- origem desta linha. O nome da categoria carrega essa fronteira de propósito,
-- e a view devolve `baixa_origem` + `baixa_em` para a tela mostrar QUAL registro
-- sustenta a afirmação, em vez de pedir confiança.
--
-- E o inverso também vale: status `PAGO` na parcela NÃO entra em nenhuma regra
-- aqui. Medido: `parcelas.origem_baixa` só tem 'GATILHO_IMPORTACAO' (1.321) e
-- 'ADM' (1). Quem prova é `origem_baixa_ref`, não status.
--
-- -----------------------------------------------------------------------------
-- O QUE REUSA, EM VEZ DE RECRIAR
-- -----------------------------------------------------------------------------
-- O MOTIVO de cada pendência vem de `vw_fila_pagamento_triagem`, da PR #737 --
-- mesma fonte de texto, para não existirem dois vocabulários de motivo no
-- sistema. Nenhuma regra financeira nova é criada aqui: as categorias desta
-- view são uma PROJEÇÃO da triagem já aprovada sobre o recorte por arquivo.
-- Conferido: a triagem cobre 453 pagamentos, exatamente o universo "dentro da
-- janela e sem baixa", e zero baixados.
--
-- O portão das funções é o MESMO de `fila_pagamento_triagem_ler` (#737),
-- incluindo o `coalesce(..., false)` que recusa identidade nula -- a correção
-- aplicada em 22/10 nas nove funções de allowlist.
--
-- ROLLBACK: supabase/rollbacks/20261023210000_importacao_conferencia_por_arquivo.rollback.sql
begin;

-- -----------------------------------------------------------------------------
-- A VIEW: uma linha por pagamento, categoria EXCLUSIVA
-- -----------------------------------------------------------------------------
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

-- -----------------------------------------------------------------------------
-- FUNÇÃO 1: a lista de arquivos, com o resumo por categoria
-- -----------------------------------------------------------------------------
-- LEFT JOIN de propósito: medido que 230 importações de projeção não têm NENHUM
-- pagamento (todas as linhas caíram na dedup). Elas precisam aparecer com zero,
-- senão a gestão importa um arquivo, não o encontra na lista e não consegue
-- distinguir "importou zero" de "o arquivo não está aqui".
create or replace function public.importacao_conferencia_arquivos(
  p_limite integer default 30)
returns table (
  importacao_id uuid,
  arquivo_nome text,
  importado_em timestamp without time zone,
  importado_por text,
  importacao_status text,
  pagamentos integer,
  valor_total numeric,
  baixa_registrada_crm integer,
  baixa_registrada_valor numeric,
  baixa_pendente integer,
  baixa_pendente_valor numeric,
  divergencia integer,
  divergencia_valor numeric,
  sem_vinculo integer,
  sem_vinculo_valor numeric,
  fora_da_janela integer,
  fora_da_janela_valor numeric,
  nao_classificado integer,
  com_suspeita_duplicidade integer,
  pendencias_historicas_relacionadas integer
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- MESMO PORTÃO de `fila_pagamento_triagem_ler` (#737), com a recusa explícita
  -- de identidade nula: sem o `coalesce(..., false)`, um token sem claim de
  -- e-mail faria `usuario_e_gestao()` devolver NULL, o `not NULL` seria NULL --
  -- que não é TRUE -- e o `if` não dispararia.
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'A conferencia de pagamentos por arquivo e da gestao financeira.'
      using errcode = '42501';
  end if;

  return query
  select
    i.id,
    i.arquivo_nome,
    i.created_at,
    i.usuario,
    i.status,
    count(v.pagamento_id)::integer,
    coalesce(sum(v.valor_pago), 0)::numeric,
    count(*) filter (where v.categoria = 'BAIXA_REGISTRADA_CRM')::integer,
    coalesce(sum(v.valor_pago) filter (where v.categoria = 'BAIXA_REGISTRADA_CRM'), 0)::numeric,
    count(*) filter (where v.categoria = 'BAIXA_PENDENTE')::integer,
    coalesce(sum(v.valor_pago) filter (where v.categoria = 'BAIXA_PENDENTE'), 0)::numeric,
    count(*) filter (where v.categoria = 'DIVERGENCIA')::integer,
    coalesce(sum(v.valor_pago) filter (where v.categoria = 'DIVERGENCIA'), 0)::numeric,
    count(*) filter (where v.categoria = 'SEM_VINCULO')::integer,
    coalesce(sum(v.valor_pago) filter (where v.categoria = 'SEM_VINCULO'), 0)::numeric,
    count(*) filter (where v.categoria = 'FORA_DA_JANELA')::integer,
    coalesce(sum(v.valor_pago) filter (where v.categoria = 'FORA_DA_JANELA'), 0)::numeric,
    count(*) filter (where v.categoria = 'NAO_CLASSIFICADO')::integer,
    count(*) filter (where v.tem_suspeita_duplicidade)::integer,
    -- ITEM 9: pendência que a linha da fila atribui a ESTE arquivo mas cujo
    -- pagamento pertence a OUTRO. Fica DESTACADA e FORA das contagens acima,
    -- que são todas por `pagamentos.importacao_id`.
    (select count(*)::integer
       from public.fila_pagamento_sem_vinculo f2
       join public.pagamentos p2 on p2.id = f2.pagamento_id
      where f2.importacao_id = i.id
        and p2.importacao_id is distinct from i.id
        and f2.conclusao is null and f2.decisao is null)
  from public.importacoes i
  left join public.vw_importacao_conferencia v
    on v.importacao_id = i.id
  where i.tipo in ('PROJECAO_DIARIA', 'PROJECAO_RETROATIVA')
  group by i.id, i.arquivo_nome, i.created_at, i.usuario, i.status
  order by i.created_at desc
  limit greatest(coalesce(p_limite, 30), 1);
end;
$function$;

comment on function public.importacao_conferencia_arquivos(integer) is
  'Lista os arquivos de projecao importados com o resumo por categoria. '
  'LEFT JOIN de proposito: 230 importacoes nao tem pagamento e precisam aparecer com zero. '
  'pendencias_historicas_relacionadas fica FORA das contagens, por desenho (item 9).';

-- -----------------------------------------------------------------------------
-- FUNÇÃO 2: as linhas de um arquivo
-- -----------------------------------------------------------------------------
create or replace function public.importacao_conferencia_ler(
  p_importacao_id uuid,
  p_categoria text default null,
  p_busca text default null,
  p_limite integer default 500)
returns table (
  pagamento_id uuid,
  categoria text,
  data_pagamento date,
  valor_pago numeric,
  valor_honorario numeric,
  aluno_id uuid,
  aluno_nome text,
  matricula text,
  titulo_numero text,
  numero_parcela_completo text,
  operador_nome text,
  status_conciliacao text,
  origem_vinculo text,
  parcela_baixada_id uuid,
  baixa_origem text,
  baixa_em timestamp with time zone,
  triagem_subcategoria text,
  triagem_motivo text,
  acao_sugerida text,
  tem_suspeita_duplicidade boolean,
  fila_aberta boolean,
  fila_de_outro_arquivo boolean
)
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'A conferencia de pagamentos por arquivo e da gestao financeira.'
      using errcode = '42501';
  end if;

  return query
  select
    v.pagamento_id, v.categoria, v.data_pagamento, v.valor_pago, v.valor_honorario,
    v.aluno_id, v.aluno_nome, v.matricula, v.titulo_numero, v.numero_parcela_completo,
    v.operador_nome, v.status_conciliacao, v.origem_vinculo,
    v.parcela_baixada_id, v.baixa_origem, v.baixa_em,
    v.triagem_subcategoria, v.triagem_motivo, v.acao_sugerida,
    v.tem_suspeita_duplicidade, v.fila_aberta, v.fila_de_outro_arquivo
  from public.vw_importacao_conferencia v
  where v.importacao_id = p_importacao_id
    and (p_categoria is null or v.categoria = p_categoria)
    -- Busca por aluno, matrícula, acordo (titulo_numero) e parcela. `unaccent`
    -- NÃO é usado aqui de propósito: a coluna vem do arquivo do banco, sem
    -- acento normalizado, e ILIKE já resolve o caso de caixa.
    and (
      p_busca is null or btrim(p_busca) = '' or
      v.aluno_nome ilike '%' || btrim(p_busca) || '%' or
      v.matricula ilike '%' || btrim(p_busca) || '%' or
      v.titulo_numero ilike '%' || btrim(p_busca) || '%' or
      v.numero_parcela_completo ilike '%' || btrim(p_busca) || '%'
    )
  order by
    -- Ordem de trabalho: o que precisa de gente primeiro, baixado por último.
    case v.categoria
      when 'DIVERGENCIA' then 1
      when 'SEM_VINCULO' then 2
      when 'BAIXA_PENDENTE' then 3
      when 'NAO_CLASSIFICADO' then 4
      when 'FORA_DA_JANELA' then 5
      else 6
    end,
    v.valor_pago desc nulls last,
    v.pagamento_id
  limit greatest(coalesce(p_limite, 500), 1);
end;
$function$;

comment on function public.importacao_conferencia_ler(uuid, text, text, integer) is
  'Linhas de conferencia de um arquivo, com filtro por categoria e busca por '
  'aluno/matricula/acordo/parcela. Somente leitura, portao de gestao.';

-- Função nova herda EXECUTE para PUBLIC (`=X/postgres`): fechar é obrigatório.
revoke all on function public.importacao_conferencia_arquivos(integer) from public;
revoke all on function public.importacao_conferencia_arquivos(integer) from anon;
revoke all on function public.importacao_conferencia_ler(uuid, text, text, integer) from public;
revoke all on function public.importacao_conferencia_ler(uuid, text, text, integer) from anon;

grant execute on function public.importacao_conferencia_arquivos(integer)
  to authenticated, service_role;
grant execute on function public.importacao_conferencia_ler(uuid, text, text, integer)
  to authenticated, service_role;

commit;
