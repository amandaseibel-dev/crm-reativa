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
-- 3B. RESULTADO DA ACAO: tres metricas novas, nenhuma chave removida
-- -----------------------------------------------------------------------------
-- Mesma funcao da migration 20260928201351, ADITIVA. Tudo que a aba Acoes ja
-- consome continua com o mesmo nome e o mesmo valor -- inclusive
-- `taxa_regularizacao`, que e a taxa por TITULOS e NAO foi renomeada. Entram:
--
--   alunos_regularizados        -- aluno com NENHUM titulo de volta na remessa
--                                  seguinte. Decisao da gestao: aluno com dois
--                                  titulos que regulariza um e nao o outro NAO
--                                  conta como regularizado.
--   taxa_regularizacao_alunos   -- alunos_regularizados / alunos_acionados
--   taxa_regularizacao_valor    -- valor_regularizado  / valor_acionado
--
-- Continua valendo: sem remessa seguinte, TUDO que e resultado volta nulo e
-- `aguardando_proxima_remessa` fica true. Nada e estimado.
create or replace function public.preventivo_acao_resultado(p_acao_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare
  v jsonb; v_lote uuid; v_carteira uuid; v_criado timestamptz; v_seguinte uuid;
  v_titulos int; v_regularizados int; v_ancora timestamptz; v_seguinte_em timestamptz;
  v_alunos int; v_alunos_reg int; v_valor numeric; v_valor_reg numeric;
begin
  if not public.preventivo_e_gestao() then
    raise exception 'Preventivo: acesso restrito à gestão.' using errcode = '42501';
  end if;

  select a.lote_id, a.carteira_id into v_lote, v_carteira
    from public.prev_acao a where a.id = p_acao_id;
  if v_lote is null then
    return jsonb_build_object('acao', p_acao_id, 'sem_remessa', true,
      'observacao', 'Ação sem remessa vinculada: não há o que comparar.');
  end if;

  -- A COMPARACAO E SEMPRE COM A PROXIMA REMESSA VALIDA APOS A ACAO -- nunca
  -- com uma remessa futura qualquer, e nunca com uma que entrou ANTES da acao
  -- existir. "Valida" = status CONFIRMADO; remessa CANCELADA nao serve de
  -- regua. A ancora e o mais recente entre a remessa da acao e a criacao da
  -- acao: se outra remessa entrou no intervalo, ela nao pode medir uma
  -- comunicacao que ainda nao havia sido montada.
  select l.criado_em into v_criado from public.prev_lote l where l.id = v_lote;
  select greatest(v_criado, a.criada_em) into v_ancora
    from public.prev_acao a where a.id = p_acao_id;

  select l.id, l.criado_em into v_seguinte, v_seguinte_em
    from public.prev_lote l
   where l.carteira_id = v_carteira and l.status = 'CONFIRMADO'
     and l.criado_em > v_ancora
   order by l.criado_em limit 1;

  select count(*), count(distinct d.matricula) into v_titulos, v_alunos
    from public.prev_acao_destinatario d where d.acao_id = p_acao_id and d.incluido;

  select count(*) into v_regularizados
    from public.prev_acao_destinatario d
   where d.acao_id = p_acao_id and d.incluido and v_seguinte is not null
     and not exists (select 1 from public.prev_titulo_lote n
                      where n.lote_id = v_seguinte and n.titulo_id = d.titulo_id);

  -- ALUNO regularizado: NENHUM titulo dele voltou. Agrupa por matricula e
  -- exige que a contagem de titulos de volta seja zero.
  select count(*) into v_alunos_reg from (
    select d.matricula
      from public.prev_acao_destinatario d
     where d.acao_id = p_acao_id and d.incluido and v_seguinte is not null
     group by d.matricula
    having count(*) filter (where exists (
             select 1 from public.prev_titulo_lote n
              where n.lote_id = v_seguinte and n.titulo_id = d.titulo_id)) = 0
  ) x;

  select coalesce(sum(tl.saldo_na_remessa), 0) into v_valor
    from public.prev_acao_destinatario d
    join public.prev_titulo_lote tl on tl.titulo_id = d.titulo_id and tl.lote_id = v_lote
   where d.acao_id = p_acao_id and d.incluido;

  select coalesce(sum(tl.saldo_na_remessa), 0) into v_valor_reg
    from public.prev_acao_destinatario d
    join public.prev_titulo_lote tl on tl.titulo_id = d.titulo_id and tl.lote_id = v_lote
   where d.acao_id = p_acao_id and d.incluido and v_seguinte is not null
     and not exists (select 1 from public.prev_titulo_lote n
                      where n.lote_id = v_seguinte and n.titulo_id = d.titulo_id);

  select jsonb_build_object(
    'acao', p_acao_id,
    'remessa', v_lote,
    'remessa_seguinte', v_seguinte,
    'remessa_seguinte_em', v_seguinte_em,
    'comparado_a_partir_de', v_ancora,
    'alunos_acionados', v_alunos,
    'titulos_acionados', v_titulos,
    'valor_acionado', v_valor,
    'continuam_em_aberto', case when v_seguinte is null then null else v_titulos - v_regularizados end,
    'regularizados_entre_remessas', case when v_seguinte is null then null else v_regularizados end,
    'alunos_regularizados', case when v_seguinte is null then null else v_alunos_reg end,
    'valor_regularizado', case when v_seguinte is null then null else v_valor_reg end,
    'taxa_regularizacao', case when v_seguinte is null or v_titulos = 0 then null
                               else round((v_regularizados::numeric / v_titulos) * 100, 1) end,
    'taxa_regularizacao_alunos', case when v_seguinte is null or v_alunos = 0 then null
                               else round((v_alunos_reg::numeric / v_alunos) * 100, 1) end,
    'taxa_regularizacao_valor', case when v_seguinte is null or v_valor = 0 then null
                               else round((v_valor_reg / v_valor) * 100, 1) end,
    'aguardando_proxima_remessa', (v_seguinte is null),
    'definicao', 'Apareceu na remessa = em aberto. Recebeu ação = acionado. NÃO apareceu na PRÓXIMA REMESSA VÁLIDA depois da ação = regularizado. Continuou aparecendo = continua em aberto. Regularizado NÃO é pagamento confirmado: some por pagamento, cancelamento, bolsa, renegociação ou por não entrar no recorte do relatório. O valor usa o saldo do título NA REMESSA em que ele foi acionado. Aluno regularizado = NENHUM título dele voltou.'
  ) into v;
  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4. RELATORIO POR CONTEXTO, POR CANAL E POR PERIODO
-- -----------------------------------------------------------------------------
-- Agrupa os MESMOS numeros que `preventivo_acao_resultado` ja produz por acao
-- -- nao reimplementa a comparacao entre remessas. Acao antiga cai no balde
-- SEM_CONTEXTO. `contexto` e `canal` sao eixos independentes: o retorno traz
-- o total do contexto E a quebra por canal dentro dele.
--
-- O agregador vive numa funcao propria para a conta existir UMA vez, usada
-- pelo total do contexto e pela quebra por canal. Ela recebe os resultados
-- como ARGUMENTO e nao le nada do banco -- por isso NAO e security definer.
create or replace function public.preventivo_contexto_metricas(p_itens jsonb)
returns jsonb
language sql
immutable
set search_path to 'public'
as $$
  with x as (select j from jsonb_array_elements(coalesce(p_itens, '[]'::jsonb)) as e(j))
  select jsonb_build_object(
    'acoes', count(*),
    'acoes_com_envio_confirmado', count(*) filter (where (j->>'envio_confirmado') = 'true'),
    'alunos_acionados',  coalesce(sum((j->>'alunos_acionados')::int), 0),
    'titulos_acionados', coalesce(sum((j->>'titulos_acionados')::int), 0),
    'valor_acionado',    coalesce(sum((j->>'valor_acionado')::numeric), 0),
    'continuam_em_aberto',          coalesce(sum((j->>'continuam_em_aberto')::int), 0),
    'regularizados_entre_remessas', coalesce(sum((j->>'regularizados_entre_remessas')::int), 0),
    'valor_regularizado',           coalesce(sum((j->>'valor_regularizado')::numeric), 0),
    'aguardando_proxima_remessa', count(*) filter (where (j->>'aguardando_proxima_remessa')::boolean),
    -- A taxa so considera as acoes que JA tem remessa seguinte para comparar.
    -- Somar no denominador acao sem comparacao rebaixaria a taxa por nada.
    'taxa_regularizacao', case
      when coalesce(sum((j->>'titulos_acionados')::int) filter (
             where (j->>'regularizados_entre_remessas') is not null), 0) = 0 then null
      else round(
        coalesce(sum((j->>'regularizados_entre_remessas')::int), 0)::numeric
        / sum((j->>'titulos_acionados')::int) filter (
            where (j->>'regularizados_entre_remessas') is not null) * 100, 1) end
  ) from x;
$$;

create or replace function public.preventivo_resultados_por_contexto(
  p_carteira_id uuid, p_de date default null, p_ate date default null)
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
  if p_de is not null and p_ate is not null and p_ate < p_de then
    raise exception 'Período inválido: "até" é anterior a "de".' using errcode = '22023';
  end if;

  with base as (
    -- O periodo corta pela DATA DE CRIACAO da acao, em America/Sao_Paulo, e os
    -- dois limites sao inclusivos. Nulo em um lado = sem limite daquele lado.
    select coalesce(a.contexto, 'SEM_CONTEXTO') as ctx,
           a.canal,
           r.j || jsonb_build_object('envio_confirmado', a.envio_confirmado_em is not null) as j
      from public.prev_acao a
      cross join lateral (select public.preventivo_acao_resultado(a.id) as j) r
     where a.carteira_id = p_carteira_id
       and a.cancelada_em is null
       and (p_de  is null or (a.criada_em at time zone 'America/Sao_Paulo')::date >= p_de)
       and (p_ate is null or (a.criada_em at time zone 'America/Sao_Paulo')::date <= p_ate)
  ), por_canal as (
    select ctx, canal, public.preventivo_contexto_metricas(jsonb_agg(j)) as m
      from base group by 1, 2
  ), por_ctx as (
    select ctx, public.preventivo_contexto_metricas(jsonb_agg(j)) as m
      from base group by 1
  )
  select jsonb_build_object(
    'periodo', jsonb_build_object('de', p_de, 'ate', p_ate),
    'definicao', 'Regularizado entre remessas = o título acionado não voltou no '
              || 'relatório de inadimplência seguinte. NÃO é pagamento confirmado '
              || 'e NÃO é valor recuperado. Some por pagamento, cancelamento, '
              || 'bolsa, renegociação ou por não entrar no recorte do relatório.',
    'contextos', coalesce((
      select jsonb_object_agg(c.ctx, c.m || jsonb_build_object(
               'canais', (select jsonb_object_agg(k.canal, k.m)
                            from por_canal k where k.ctx = c.ctx)))
        from por_ctx c), '{}'::jsonb)
  ) into v;

  return v;
end;
$$;

-- -----------------------------------------------------------------------------
-- 4B. LISTA POR ACAO: a visao principal da aba Resultados
-- -----------------------------------------------------------------------------
-- Uma linha por acao, em ordem de criacao, com as nove metricas que a gestao
-- pediu mais nome, canal, contexto, estado, datas e remessa. Nao reimplementa
-- nada: cada linha e o proprio `preventivo_acao_resultado`. O corte de periodo
-- e o mesmo do relatorio por contexto -- data de CRIACAO da acao, em
-- America/Sao_Paulo, limites inclusivos.
--
-- Acao CANCELADA aparece, com o estado escrito, porque faz parte do historico.
-- Quem nao quiser ve-la filtra na tela.
create or replace function public.preventivo_resultados_por_acao(
  p_carteira_id uuid, p_de date default null, p_ate date default null)
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
  if p_de is not null and p_ate is not null and p_ate < p_de then
    raise exception 'Período inválido: "até" é anterior a "de".' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(linha order by criada_em), '[]'::jsonb) into v
  from (
    select a.criada_em,
           jsonb_build_object(
             'id', a.id,
             'nome', a.nome,
             'canal', a.canal,
             'contexto', coalesce(a.contexto, 'SEM_CONTEXTO'),
             'estado', a.estado,
             'criada_em', a.criada_em,
             'criada_por', a.criada_por,
             'exportada_em', a.exportada_em,
             'envio_confirmado_em', a.envio_confirmado_em,
             'cancelada_em', a.cancelada_em,
             'remessa', a.lote_id,
             'remessa_nome', (select l.nome from public.prev_lote l where l.id = a.lote_id)
           ) || r.j as linha
      from public.prev_acao a
      cross join lateral (select public.preventivo_acao_resultado(a.id) as j) r
     where a.carteira_id = p_carteira_id
       and (p_de  is null or (a.criada_em at time zone 'America/Sao_Paulo')::date >= p_de)
       and (p_ate is null or (a.criada_em at time zone 'America/Sao_Paulo')::date <= p_ate)
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
revoke all on function public.preventivo_resultados_por_contexto(uuid, date, date) from public, anon;
revoke all on function public.preventivo_contexto_metricas(jsonb) from public, anon;
revoke all on function public.preventivo_resultados_por_acao(uuid, date, date) from public, anon;
grant execute on function public.preventivo_acao_preparar_v2(uuid, text, text, jsonb, text) to authenticated;
grant execute on function public.preventivo_resultados_por_contexto(uuid, date, date) to authenticated;
grant execute on function public.preventivo_contexto_metricas(jsonb) to authenticated;
grant execute on function public.preventivo_resultados_por_acao(uuid, date, date) to authenticated;
