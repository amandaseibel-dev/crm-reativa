-- PREVENTIVO: a acao passa a dizer EM QUE ETAPA DA JORNADA ela fala.
--
-- O PROBLEMA. Ate aqui a unica coisa que distinguia "avisar antes de vencer"
-- de "cobrar boleto vencido" era o NOME LIVRE que a gestao digitava. Nome
-- livre nao agrega: nao da para medir resultado por etapa sem adivinhar por
-- substring, que e exatamente o tipo de inferencia que este projeto nao faz.
--
-- A SOLUCAO, MINIMA. Um campo tipado em `prev_acao`, com dominio fechado de
-- dois valores, e uma RPC NOVA que o exige. Nada mais muda:
--
--   * importacao, janela de 31 dias, sincronizacao com o Prime e a maquina de
--     estados PREPARADA -> EXPORTADA -> ENVIO_CONFIRMADO ficam INTOCADAS;
--   * `canal` (WHATSAPP/EMAIL) segue independente de `contexto`: sao eixos
--     diferentes e qualquer combinacao e valida;
--   * a palavra continua sendo `regularizado entre remessas`. Em lugar nenhum
--     deste arquivo aparece "pago" ou "recuperado" como resultado.
--
-- NULLABLE DE PROPOSITO. Acao criada antes desta migration fica com
-- `contexto` nulo e reporta como SEM_CONTEXTO. Nenhum backfill: o contexto de
-- uma acao antiga nao esta em lugar nenhum, e deduzi-lo por data de
-- vencimento ou por palavra no nome seria inventar.
--
-- POR QUE NAO HA `check (contexto is not null) not valid`. Pareceria elegante
-- -- toleraria linha antiga e obrigaria nas novas -- mas NOT VALID tambem
-- vale para UPDATE de linha antiga, e `preventivo_acao_marcar` faz UPDATE em
-- prev_acao. Uma acao antiga sem contexto nao conseguiria mais mudar de
-- estado. A obrigacao mora na RPC.

-- -----------------------------------------------------------------------------
-- 1. O CAMPO
-- -----------------------------------------------------------------------------
alter table public.prev_acao add column if not exists contexto text;

alter table public.prev_acao drop constraint if exists prev_acao_contexto_check;
alter table public.prev_acao add constraint prev_acao_contexto_check
  check (contexto is null or contexto in ('PROXIMO_VENCIMENTO', 'BOLETO_VENCIDO'));

comment on column public.prev_acao.contexto is
  'Etapa da jornada que a acao endereca. PROXIMO_VENCIMENTO = o titulo ainda '
  'nao venceu. BOLETO_VENCIDO = ja venceu e segue dentro da janela de 31 dias. '
  'NULL so existe em acao anterior a 20261005191400: reporta como SEM_CONTEXTO '
  'e NUNCA e inferido por data nem por nome. Independente de `canal`.';

create index if not exists prev_acao_contexto_idx
  on public.prev_acao (carteira_id, contexto);

-- -----------------------------------------------------------------------------
-- 2. RESUMO DA ACAO: devolve o contexto e CONFERE, sem bloquear
-- -----------------------------------------------------------------------------
-- `conferencia_contexto` e irma de `conferencia_financeira`, que ja existia:
-- nao impede nada, so nao deixa a lista passar por conferida. O rotulo e
-- escolha humana e NAO e validado contra o vencimento -- preparar uma acao
-- PROXIMO_VENCIMENTO com titulo vencido continua permitido, e a tela mostra
-- quantos sao.
create or replace function public.preventivo_acao_resumo(p_acao_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v jsonb; v_hoje date := public.preventivo_hoje();
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'id', a.id, 'nome', a.nome, 'canal', a.canal, 'contexto', a.contexto,
    'estado', a.estado, 'filtros', a.filtros,
    'criada_em', a.criada_em, 'criada_por', a.criada_por,
    'exportada_em', a.exportada_em, 'envio_confirmado_em', a.envio_confirmado_em,
    'cancelada_em', a.cancelada_em,
    'atualizacao_financeira', jsonb_build_object('sinc_id', a.sinc_referencia_id, 'em', a.sinc_referencia_em),
    'incluidos', (select count(*) from public.prev_acao_destinatario d where d.acao_id = a.id and d.incluido),
    'alunos', (select count(distinct d.matricula) from public.prev_acao_destinatario d where d.acao_id = a.id and d.incluido),
    'separados', (select coalesce(jsonb_object_agg(motivo, n), '{}'::jsonb)
                    from (select motivo, count(*) n from public.prev_acao_destinatario
                           where acao_id = a.id and not incluido and motivo is not null group by 1) s),
    -- Não bloqueia, mas não deixa a lista passar por conferida.
    'conferencia_financeira', (
      select coalesce(jsonb_object_agg(vinculo_prime, n), '{}'::jsonb)
        from (select t.vinculo_prime, count(*) n
                from public.prev_acao_destinatario d
                join public.prev_titulo t on t.id = d.titulo_id
               where d.acao_id = a.id and d.incluido group by 1) c),
    -- Conferência do rótulo contra o vencimento. Informativa, nunca trava.
    'conferencia_contexto', case when a.contexto is null then null else (
      select jsonb_build_object(
        'contexto', a.contexto,
        'titulos_incluidos', count(*),
        'divergentes', count(*) filter (
          where (a.contexto = 'PROXIMO_VENCIMENTO' and t.vencimento <  v_hoje)
             or (a.contexto = 'BOLETO_VENCIDO'     and t.vencimento >= v_hoje)),
        'rotulo_divergencia', case a.contexto
          when 'PROXIMO_VENCIMENTO' then 'títulos selecionados que JÁ venceram'
          when 'BOLETO_VENCIDO'     then 'títulos selecionados que AINDA não venceram'
        end)
        from public.prev_acao_destinatario d
        join public.prev_titulo t on t.id = d.titulo_id
       where d.acao_id = a.id and d.incluido) end
  ) into v
  from public.prev_acao a
  where a.id = p_acao_id;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3. A RPC NOVA, VERSIONADA
-- -----------------------------------------------------------------------------
-- `preventivo_acao_preparar` (4 args) CONTINUA EXISTINDO, de proposito: trocar
-- a assinatura no mesmo instante do deploy abriria uma janela em que o front
-- antigo chama uma funcao que nao existe mais. A v1 sai depois, em migration
-- propria, quando a producao estiver validada.
--
-- A v2 NAO COPIA a selecao de publico. Ela delega para a v1 e carimba o
-- contexto na acao recem-criada, na MESMA transacao. E deliberado: copiar as
-- ~90 linhas de regra de elegibilidade criaria duas versoes para divergir.
-- CONSEQUENCIA A NAO ESQUECER: enquanto a v2 existir, a v1 NAO pode ser
-- removida sem antes mover o corpo para dentro da v2.
create or replace function public.preventivo_acao_preparar_v2(
  p_carteira_id uuid, p_nome text, p_canal text, p_filtros jsonb, p_contexto text)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v jsonb; v_acao uuid; v_ctx text := upper(btrim(coalesce(p_contexto, '')));
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;
  if v_ctx = '' then
    raise exception 'Informe o contexto da ação: PROXIMO_VENCIMENTO ou BOLETO_VENCIDO.'
      using errcode = '22023';
  end if;
  if v_ctx not in ('PROXIMO_VENCIMENTO', 'BOLETO_VENCIDO') then
    raise exception 'Contexto inválido: %. Use PROXIMO_VENCIMENTO ou BOLETO_VENCIDO.', v_ctx
      using errcode = '22023';
  end if;

  v := public.preventivo_acao_preparar(p_carteira_id, p_nome, p_canal, coalesce(p_filtros, '{}'::jsonb));
  v_acao := (v->>'id')::uuid;

  update public.prev_acao set contexto = v_ctx where id = v_acao;

  return public.preventivo_acao_resumo(v_acao);
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. RELATORIO POR CONTEXTO
-- -----------------------------------------------------------------------------
-- Agrupa por contexto os MESMOS numeros que `preventivo_acao_resultado` ja
-- produz por acao -- nao reimplementa a comparacao entre remessas. Acao antiga
-- cai no balde SEM_CONTEXTO.
create or replace function public.preventivo_resultados_por_contexto(p_carteira_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v jsonb;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;

  select coalesce(jsonb_object_agg(k, linha), '{}'::jsonb) into v
  from (
    select coalesce(a.contexto, 'SEM_CONTEXTO') as k,
           jsonb_build_object(
             'acoes', count(*),
             'acoes_com_envio_confirmado', count(*) filter (where a.envio_confirmado_em is not null),
             'alunos_acionados',  coalesce(sum((r.j->>'alunos_acionados')::int), 0),
             'titulos_acionados', coalesce(sum((r.j->>'titulos_acionados')::int), 0),
             'valor_acionado',    coalesce(sum((r.j->>'valor_acionado')::numeric), 0),
             'continuam_em_aberto',          coalesce(sum((r.j->>'continuam_em_aberto')::int), 0),
             'regularizados_entre_remessas', coalesce(sum((r.j->>'regularizados_entre_remessas')::int), 0),
             'valor_regularizado',           coalesce(sum((r.j->>'valor_regularizado')::numeric), 0),
             'aguardando_proxima_remessa', count(*) filter (where (r.j->>'aguardando_proxima_remessa')::boolean),
             'taxa_regularizacao', case
               when coalesce(sum((r.j->>'titulos_acionados')::int) filter (
                      where (r.j->>'regularizados_entre_remessas') is not null), 0) = 0 then null
               else round(
                 coalesce(sum((r.j->>'regularizados_entre_remessas')::int), 0)::numeric
                 / nullif(sum((r.j->>'titulos_acionados')::int) filter (
                     where (r.j->>'regularizados_entre_remessas') is not null), 0) * 100, 1) end,
             'definicao', 'Regularizado entre remessas = o título acionado não voltou no '
                       || 'relatório de inadimplência seguinte. NÃO é pagamento confirmado '
                       || 'e NÃO é valor recuperado. Some por pagamento, cancelamento, '
                       || 'bolsa, renegociação ou por não entrar no recorte do relatório.'
           ) as linha
      from public.prev_acao a
      cross join lateral (select public.preventivo_acao_resultado(a.id) as j) r
     where a.carteira_id = p_carteira_id
       and a.cancelada_em is null
     group by 1
  ) q;

  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- 5. PRIVILEGIOS
-- -----------------------------------------------------------------------------
-- Funcao nova NAO herda os grants da tabela: ela nasce com EXECUTE para
-- `public`, o que inclui `anon`. O portao de gestao mora dentro de cada uma,
-- mas a porta tambem se fecha aqui.
revoke all on function public.preventivo_acao_preparar_v2(uuid, text, text, jsonb, text) from public, anon;
revoke all on function public.preventivo_resultados_por_contexto(uuid) from public, anon;
grant execute on function public.preventivo_acao_preparar_v2(uuid, text, text, jsonb, text) to authenticated;
grant execute on function public.preventivo_resultados_por_contexto(uuid) to authenticated;
