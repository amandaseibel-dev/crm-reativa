-- TRIAGEM DA FILA DE PAGAMENTOS: as 448 pendencias ganham categoria, sem fila
-- nova e sem nenhuma decisao automatica.
--
-- POR QUE. Medido em producao em 22/10/2026: 448 pagamentos com
-- `status_conciliacao` pendente, R$ 377.515,27. A rodada horaria (jobs 73/74/75)
-- processa 25 por hora e devolve `baixados: 0` em TODAS as execucoes, e
-- `pendentes` nao cai -- subiu 420 -> 448 ao longo do dia 22/10. O motivo nao e
-- defeito da rodada: 265 dos 448 (59% das linhas, R$ 186.318,47) dependem da
-- etapa `consulta_portador`, DESLIGADA pela gestao desde 15/09/2026. O orcamento
-- de 25 vagas/hora e gasto majoritariamente numa categoria cuja unica porta de
-- saida esta fechada. Hoje nada no banco diz isso: quem abre a tela vê 448
-- linhas com motivo em texto e descobre caso a caso.
--
-- O QUE ESTA MIGRATION FAZ, E O QUE NAO FAZ. Cria uma VIEW de leitura e uma
-- funcao leitora. ZERO DML: nao toca pagamento, acordo, parcela, baixa, status,
-- etapa, job, tentativa nem os 8.955 pagamentos historicos anteriores a
-- 11/09/2026 (que seguem fora de qualquer alcance, aqui e na rodada). Nao
-- religa etapa nenhuma -- apenas LÊ `fluxo_pagamentos_config` para dizer quando
-- uma pendencia esta parada por causa de uma etapa desligada.
--
-- DADO ESTRUTURADO MANDA; TEXTO LIVRE SO ONDE NAO HA COLUNA. A ordem nao e
-- estetica: `sugestoes` (jsonb), `decisao`, `consulta_portador_em` e
-- `fluxo_pagamentos_config.ligado` sao colunas, e decidem primeiro. O `motivo`
-- e texto escrito pelo motor em varios pontos e entra por ultimo, so onde nao
-- existe coluna equivalente. A prova de que essa ordem importa esta na propria
-- producao: 42 pendencias tem `sugestoes` preenchido e apenas 11 mencionam
-- sugestao no texto do motivo -- 31 ficariam invisiveis a quem lesse o texto.
--
-- A ETAPA BLOQUEADORA VEM DA CONFIGURACAO, NAO DO NOME FIXO NO SQL. O mapa
-- `padrao do motivo -> etapa` e declarado em `_dependencia` e cruzado com
-- `fluxo_pagamentos_config` EM TEMPO DE CONSULTA. Consequencia desejada: no dia
-- em que a gestao religar `consulta_portador`, as 265 linhas saem sozinhas de
-- BLOQUEADO_ETAPA_DESATIVADA e viram AGUARDANDO_INFORMACAO_ACORDO, sem ninguem
-- editar esta view. Se o mapa trouxesse o nome da etapa cravado numa condicao,
-- a classificacao mentiria a partir do segundo dia.
--
-- ACORDO CANCELADO NAO GANHA ACAO AQUI. As 7 pendencias cujo motivo diz
-- "CANCELADO, nao ATIVO" (R$ 4.511,23) sao as MESMAS da frente da PR #694
-- (`fila_pagamento_parcela_cancelada`). Elas entram na triagem para serem
-- CONTADAS -- some-las no total e o que fecha os 448 --, com subcategoria
-- `acordo_cancelado_fluxo_proprio` e `acao_sugerida` NULA. A regra desta casa:
-- submotivo sem acao segura nao ganha botao. Criar aqui um segundo caminho de
-- decisao para o mesmo caso seria decidir dinheiro em dois lugares, com dois
-- historicos. A condicao vem ANTES das de acionavel exatamente para que uma
-- sugestao de aluno nunca promova um desses casos a acionavel.
--
-- UMA LINHA POR PAGAMENTO, POR CONSTRUCAO. A promessa nao vem de `distinct`:
-- vem do indice unico `fila_pag_sem_vinculo_unico` em
-- `fila_pagamento_sem_vinculo(pagamento_id)`, que torna o LEFT JOIN incapaz de
-- multiplicar linha. O portao no fim deste arquivo CONFERE que o indice existe
-- -- se alguem o remover, esta migration passa a falhar em vez de a view passar
-- a duplicar em silencio.
--
-- OS 33 QUE NINGUEM VE, E O PREDICADO QUE OS ESCONDE. 33 pendencias
-- (R$ 83.203,30) tem decisao registrada na fila (`FEITO` 9,
-- `RESOLVIDO_AUTOMATICO` 19, `ENCERRADO_GESTAO` 5) e o `status_conciliacao` do
-- pagamento nunca saiu de pendente. O MESMO predicado as exclui dos dois lados:
--
--     and not exists (select 1 from public.fila_pagamento_sem_vinculo fd
--                      where fd.pagamento_id = p.id and fd.decisao is not null)
--
-- esta em `pagamentos_sem_aluno` (a tela) e em `fluxo_pagamentos_incremental`
-- (a rodada). Decididas, saem da tela; decididas, a rodada as pula. Ninguem as
-- ve e ninguem as reprocessa. Esta view NAO herda esse predicado -- de
-- proposito: herdando, a categoria CONFERENCIA_HUMANA nasceria vazia por
-- construcao, e os 33 continuariam invisiveis. Elas aparecem com
-- `acao_sugerida` nula: o que falta ali e conferencia, nao acao nova.
--
-- POR QUE UMA VIEW *E* UMA FUNCAO, e nao a view sozinha. `fila_pagamento_sem_vinculo`
-- tem RLS LIGADO e NENHUMA policy (conferido em 22/10/2026): para
-- `authenticated`, RLS sem policy nao devolve linha nenhuma. E uma view com o
-- padrao `security_invoker = false`, se recebesse grant, leria como DONA e
-- passaria por cima do RLS de `pagamentos` -- entregando a fila financeira a
-- qualquer pessoa logada. Por isso a view e REVOGADA de `anon`/`authenticated`
-- e a unica porta e `fila_pagamento_triagem_ler()`, SECURITY DEFINER com o
-- mesmo portao de gestao de `pagamentos_sem_aluno` e `pagamentos_trava`.
--
-- O PORTAO RECUSA IDENTIDADE NULA. `coalesce(usuario_e_gestao(), false)` em vez
-- de `usuario_e_gestao()` cru, e `auth.email()` conferido contra NULL antes de
-- qualquer comparacao. A licao e da importacao do Santander (PR #727/#728):
-- `NULL NOT IN (...)` avalia para NULL, que nao e TRUE, o `IF` nao dispara e a
-- funcao segue adiante com autoria nula. Aqui a leitura e so leitura, mas o
-- padrao da casa e fechar a porta do mesmo jeito em toda funcao nova.
--
-- ESTA MIGRATION NAO FOI APLICADA EM PRODUCAO.

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

create or replace function public.fila_pagamento_triagem_ler(
  p_categoria text default null,
  p_limite    integer default 1000
)
returns table (
  pagamento_id uuid,
  aluno_id uuid,
  data_pagamento date,
  valor_pago numeric,
  status_conciliacao text,
  titulo_numero text,
  boleto text,
  categoria text,
  subcategoria text,
  etapa_desligada text,
  acao_sugerida text,
  motivo text,
  sugestoes jsonb,
  decisao text,
  decidido_por text,
  decidido_em timestamptz,
  toques_na_linha integer,
  primeira_tentativa_em timestamptz,
  consulta_portador_em timestamptz
)
language plpgsql
stable
security definer
set search_path to 'public'
as $$
begin
  -- MESMO PORTAO de `pagamentos_sem_aluno` e `pagamentos_trava`, com a recusa
  -- explicita de identidade nula. `coalesce(..., false)`: sem isto, um token sem
  -- claim de e-mail faria `usuario_e_gestao()` devolver NULL, o `not NULL` seria
  -- NULL -- que nao e TRUE -- e o `if` nao dispararia.
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'A triagem da fila de pagamentos e da gestao financeira.'
      using errcode = '42501';
  end if;

  return query
  select t.pagamento_id, t.aluno_id, t.data_pagamento, t.valor_pago,
         t.status_conciliacao, t.titulo_numero, t.boleto,
         t.categoria, t.subcategoria, t.etapa_desligada, t.acao_sugerida,
         t.motivo, t.sugestoes, t.decisao, t.decidido_por, t.decidido_em,
         t.toques_na_linha, t.primeira_tentativa_em, t.consulta_portador_em
    from public.vw_fila_pagamento_triagem t
   where p_categoria is null or t.categoria = p_categoria
   -- Maior valor primeiro dentro da categoria: quem confere comeca pelo que
   -- pesa. `pagamento_id` como desempate e so estabilidade de ordem -- NAO e
   -- criterio de prioridade, e nao deve ser lido como tal.
   order by t.categoria, t.valor_pago desc nulls last, t.pagamento_id
   limit greatest(coalesce(p_limite, 1000), 1);
end
$$;

comment on function public.fila_pagamento_triagem_ler(text, integer) is
  'Porta unica de leitura da vw_fila_pagamento_triagem. Portao de gestao financeira, '
  'recusa identidade nula. SOMENTE LEITURA: nao grava, nao decide, nao baixa.';

revoke all on function public.fila_pagamento_triagem_ler(text, integer) from public;
revoke all on function public.fila_pagamento_triagem_ler(text, integer) from anon;
grant execute on function public.fila_pagamento_triagem_ler(text, integer) to authenticated;
grant execute on function public.fila_pagamento_triagem_ler(text, integer) to service_role;

-- ============================================================================
-- PORTAO DE SANIDADE. Falha a migration em vez de deixar a view mentir depois.
-- ============================================================================
do $guarda$
declare
  v_src text;
begin
  -- A promessa de "uma linha por pagamento" repousa neste indice. Sem ele, o
  -- LEFT JOIN pode multiplicar e a triagem passaria a contar o mesmo dinheiro
  -- duas vezes sem ninguem notar.
  if not exists (
    select 1 from pg_index i
    where i.indrelid = 'public.fila_pagamento_sem_vinculo'::regclass
      and i.indisunique
      and (select array_agg(a.attname::text order by a.attname)
             from pg_attribute a
            where a.attrelid = i.indrelid and a.attnum = any (i.indkey))
          = array['pagamento_id']
  ) then
    raise exception 'triagem: faltou o indice unico em fila_pagamento_sem_vinculo(pagamento_id); '
                    'sem ele a view nao garante uma linha por pagamento.';
  end if;

  -- A etapa tem de vir da configuracao. Se alguem trocar o cruzamento por um
  -- nome cravado numa condicao, a classificacao congela no dia em que foi
  -- escrita.
  v_src := pg_get_viewdef('public.vw_fila_pagamento_triagem'::regclass, true);
  if position('fluxo_pagamentos_config' in v_src) = 0 then
    raise exception 'triagem: a view parou de ler fluxo_pagamentos_config e a etapa '
                    'bloqueadora viraria nome fixo.';
  end if;

  -- O predicado que esconde as linhas decididas NAO pode voltar: e ele que
  -- tornaria os 33 invisiveis outra vez.
  if position('decisao is not null' in replace(lower(v_src), 'f.decisao is not null', 'decisao is not null')) > 0
     and position('not exists' in lower(v_src)) > 0 then
    raise exception 'triagem: a view voltou a excluir linha decidida por not exists.';
  end if;

  -- Leitura e leitura. Nenhuma escrita pode ter entrado na funcao leitora.
  v_src := (select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'fila_pagamento_triagem_ler');
  if v_src ~* '\m(insert|update|delete|truncate)\M' then
    raise exception 'triagem: entrou escrita na funcao leitora.';
  end if;
  if position('usuario_e_gestao' in v_src) = 0 then
    raise exception 'triagem: o portao de gestao saiu da funcao leitora.';
  end if;
  if position('coalesce(public.usuario_e_gestao(), false)' in v_src) = 0 then
    raise exception 'triagem: o portao voltou a aceitar identidade nula.';
  end if;

  -- A view nao pode estar aberta a quem esta logado: seria a fila financeira
  -- inteira por cima do RLS.
  if has_table_privilege('authenticated', 'public.vw_fila_pagamento_triagem', 'SELECT') then
    raise exception 'triagem: authenticated ganhou SELECT na view e passaria por cima do RLS.';
  end if;
  if not has_function_privilege('authenticated',
        'public.fila_pagamento_triagem_ler(text,integer)', 'EXECUTE') then
    raise exception 'triagem: authenticated perdeu o EXECUTE e a tela nao carregaria.';
  end if;
end
$guarda$;
