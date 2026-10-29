-- ============================================================================
-- Conferencia mensal Prime (Ulbra) x Sistema  -- modulo Fechamento de Remuneracao
-- ----------------------------------------------------------------------------
-- Amanda exporta o relatorio de pagamentos do Prime (mesmo layout Santander da
-- importacao) e o sistema confere, parcela a parcela, se os valores batem EXATO.
-- Chave de cruzamento: numero_parcela_completo (coluna E do extrato = referencia
-- unica de cada boleto). Compara valor_pago e valor_honorario. Nada e alterado
-- na base -- a conferencia so APONTA divergencias (decisao Amanda 2026-08-04):
--   * so no Prime  -> sistema esta a MENOR
--   * so no sistema-> sistema esta a MAIOR (mais grave, infla comissao)
--   * valor difere -> mesma parcela, honorario ou valor pago divergem
-- Escopo: equipe TODA (inclui sem-operador e Fernanda) para o total geral fechar.
-- Acesso: EXCLUSIVO amanda.seibel@aelbra.com.br (fechamento_exigir_acesso).
-- Historico: cada conferencia fica salva em fechamento_conferencia_prime.
-- ============================================================================

create table if not exists public.fechamento_conferencia_prime (
  id uuid primary key default gen_random_uuid(),
  competencia date not null,
  criado_em timestamptz not null default now(),
  criado_por text not null default coalesce((auth.jwt() ->> 'email'), current_user),
  arquivo_nome text,
  qtd_prime integer not null default 0,
  qtd_sistema integer not null default 0,
  total_prime_valor numeric not null default 0,
  total_prime_honorario numeric not null default 0,
  total_sistema_valor numeric not null default 0,
  total_sistema_honorario numeric not null default 0,
  qtd_so_prime integer not null default 0,
  qtd_so_sistema integer not null default 0,
  qtd_divergente integer not null default 0,
  diff_valor numeric not null default 0,
  diff_honorario numeric not null default 0,
  bateu boolean not null default false,
  resumo jsonb
);

comment on table public.fechamento_conferencia_prime is
  'Historico das conferencias Prime x Sistema (modulo Fechamento de Remuneracao). Acesso exclusivo Amanda gestora via RPC SECURITY DEFINER.';

create index if not exists idx_conf_prime_competencia
  on public.fechamento_conferencia_prime (competencia desc, criado_em desc);

-- Deny-all: a tabela so e acessada pelos RPCs SECURITY DEFINER abaixo.
alter table public.fechamento_conferencia_prime enable row level security;
revoke all on public.fechamento_conferencia_prime from anon, authenticated;

-- ----------------------------------------------------------------------------
-- RPC: roda a conferencia de um mes contra as linhas do arquivo do Prime.
--   p_competencia: qualquer dia do mes de referencia.
--   p_arquivo_nome: nome do arquivo (auditoria).
--   p_linhas: jsonb array. Cada item (ja normalizado no front, layout Santander):
--     { "parcela": text, "titulo": text, "valor_pago": numeric,
--       "valor_honorario": numeric, "operador_email": text,
--       "operador_nome": text, "aluno_nome": text }
-- Retorna jsonb com o resultado completo (totais, resumo por operador e as 3
-- listas de divergencia) e grava o historico.
-- ----------------------------------------------------------------------------
create or replace function public.fechamento_conferir_prime(
  p_competencia date,
  p_arquivo_nome text,
  p_linhas jsonb
) returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_ini date := date_trunc('month', p_competencia)::date;
  v_prox date := (date_trunc('month', p_competencia) + interval '1 month')::date;
  v_mes text := to_char(p_competencia, 'YYYY-MM');
  v_res jsonb;
  v_so_prime jsonb; v_so_sistema jsonb; v_divergente jsonb; v_resumo_op jsonb;
  v_qtd_prime int; v_qtd_sistema int;
  v_tot_p_vp numeric; v_tot_p_vh numeric; v_tot_s_vp numeric; v_tot_s_vh numeric;
  v_qtd_sp int; v_qtd_ss int; v_qtd_dv int; v_bateu boolean;
  v_id uuid;
begin
  perform public.fechamento_exigir_acesso('conferir_prime');

  if p_linhas is null or jsonb_typeof(p_linhas) <> 'array' or jsonb_array_length(p_linhas) = 0 then
    raise exception 'Arquivo do Prime vazio ou invalido (nenhuma linha de pagamento lida).'
      using errcode = '22023';
  end if;

  -- Tudo em CTEs num unico statement (sem tabelas temporarias, seguro em pool):
  --   prime   = arquivo agregado por parcela (soma valores, conta linhas)
  --   sistema = pagamentos do mes agregados por parcela
  -- Operador exibido = SEMPRE o do sistema (o Prime nao redefine operador;
  -- a conferencia valida apenas os valores). Decisao Amanda 2026-08-04.
  with prime as (
    select nullif(trim(x->>'parcela'),'') as chave,
           max(nullif(trim(x->>'titulo'),'')) as titulo,
           sum(coalesce((x->>'valor_pago')::numeric, 0)) as vp,
           sum(coalesce((x->>'valor_honorario')::numeric, 0)) as vh,
           count(*) as n,
           max(nullif(trim(x->>'operador_email'),'')) as operador_email,
           max(nullif(trim(x->>'operador_nome'),'')) as operador_nome,
           max(nullif(trim(x->>'aluno_nome'),'')) as aluno_nome
    from jsonb_array_elements(p_linhas) x
    where nullif(trim(x->>'parcela'),'') is not null
    group by 1
  ),
  sistema as (
    select numero_parcela_completo as chave, max(titulo_numero) as titulo,
           sum(coalesce(valor_pago,0)) as vp, sum(coalesce(valor_honorario,0)) as vh, count(*) as n,
           max(operador_email) as operador_email, max(operador_nome) as operador_nome, max(aluno_nome) as aluno_nome
    from public.pagamentos
    where data_pagamento >= v_ini and data_pagamento < v_prox and numero_parcela_completo is not null
    group by numero_parcela_completo
  ),
  agg_p as (select count(*) q, coalesce(sum(vp),0) vp, coalesce(sum(vh),0) vh from prime),
  agg_s as (select count(*) q, coalesce(sum(vp),0) vp, coalesce(sum(vh),0) vh from sistema),
  sp as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'parcela', p.chave, 'titulo', p.titulo, 'aluno_nome', p.aluno_nome,
      'operador_email', p.operador_email, 'operador_nome', p.operador_nome,
      'valor_pago', p.vp, 'valor_honorario', p.vh, 'qtd', p.n) order by p.vp desc), '[]'::jsonb) v
    from prime p left join sistema s on s.chave = p.chave where s.chave is null
  ),
  ss as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'parcela', s.chave, 'titulo', s.titulo, 'aluno_nome', s.aluno_nome,
      'operador_email', s.operador_email, 'operador_nome', s.operador_nome,
      'valor_pago', s.vp, 'valor_honorario', s.vh, 'qtd', s.n) order by s.vp desc), '[]'::jsonb) v
    from sistema s left join prime p on p.chave = s.chave where p.chave is null
  ),
  dv as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'parcela', s.chave, 'titulo', coalesce(s.titulo, p.titulo), 'aluno_nome', coalesce(s.aluno_nome, p.aluno_nome),
      'operador_email', s.operador_email, 'operador_nome', s.operador_nome,
      'prime_valor_pago', p.vp, 'sistema_valor_pago', s.vp, 'diff_valor_pago', round(s.vp - p.vp, 2),
      'prime_honorario', p.vh, 'sistema_honorario', s.vh, 'diff_honorario', round(s.vh - p.vh, 2),
      'prime_qtd', p.n, 'sistema_qtd', s.n)
      order by abs(round(s.vh - p.vh,2)) + abs(round(s.vp - p.vp,2)) desc), '[]'::jsonb) v
    from sistema s join prime p on p.chave = s.chave
    where round(s.vp,2) <> round(p.vp,2) or round(s.vh,2) <> round(p.vh,2) or s.n <> p.n
  ),
  base_op as (
    select coalesce(s.operador_email, p.operador_email, '(SEM OPERADOR)') as operador_email,
           coalesce(max(s.operador_nome), max(p.operador_nome)) as operador_nome,
           coalesce(sum(p.vp),0) as prime_valor, coalesce(sum(p.vh),0) as prime_honorario,
           coalesce(sum(s.vp),0) as sistema_valor, coalesce(sum(s.vh),0) as sistema_honorario
    from sistema s full outer join prime p on p.chave = s.chave group by 1
  ),
  ro as (
    select coalesce(jsonb_agg(jsonb_build_object(
      'operador_email', operador_email, 'operador_nome', operador_nome,
      'prime_valor', prime_valor, 'sistema_valor', sistema_valor, 'diff_valor', round(sistema_valor - prime_valor, 2),
      'prime_honorario', prime_honorario, 'sistema_honorario', sistema_honorario, 'diff_honorario', round(sistema_honorario - prime_honorario, 2),
      'bateu', (round(sistema_valor - prime_valor,2) = 0 and round(sistema_honorario - prime_honorario,2) = 0))
      order by sistema_honorario desc), '[]'::jsonb) v
    from base_op
  )
  select agg_p.q, agg_p.vp, agg_p.vh, agg_s.q, agg_s.vp, agg_s.vh, sp.v, ss.v, dv.v, ro.v
    into v_qtd_prime, v_tot_p_vp, v_tot_p_vh, v_qtd_sistema, v_tot_s_vp, v_tot_s_vh,
         v_so_prime, v_so_sistema, v_divergente, v_resumo_op
  from agg_p, agg_s, sp, ss, dv, ro;

  v_qtd_sp := jsonb_array_length(v_so_prime);
  v_qtd_ss := jsonb_array_length(v_so_sistema);
  v_qtd_dv := jsonb_array_length(v_divergente);
  v_bateu := (v_qtd_sp = 0 and v_qtd_ss = 0 and v_qtd_dv = 0);

  v_res := jsonb_build_object(
    'competencia', v_mes,
    'periodo_inicio', v_ini,
    'periodo_fim', (v_prox - interval '1 day')::date,
    'arquivo_nome', p_arquivo_nome,
    'bateu', v_bateu,
    'qtd_prime', v_qtd_prime,
    'qtd_sistema', v_qtd_sistema,
    'totais', jsonb_build_object(
      'prime_valor', v_tot_p_vp, 'sistema_valor', v_tot_s_vp, 'diff_valor', round(v_tot_s_vp - v_tot_p_vp, 2),
      'prime_honorario', v_tot_p_vh, 'sistema_honorario', v_tot_s_vh, 'diff_honorario', round(v_tot_s_vh - v_tot_p_vh, 2)),
    'qtd_so_prime', v_qtd_sp, 'qtd_so_sistema', v_qtd_ss, 'qtd_divergente', v_qtd_dv,
    'resumo_por_operador', v_resumo_op,
    'so_no_prime', v_so_prime,
    'so_no_sistema', v_so_sistema,
    'divergentes', v_divergente,
    'gerado_em', now());

  insert into public.fechamento_conferencia_prime (
    competencia, arquivo_nome, qtd_prime, qtd_sistema,
    total_prime_valor, total_prime_honorario, total_sistema_valor, total_sistema_honorario,
    qtd_so_prime, qtd_so_sistema, qtd_divergente, diff_valor, diff_honorario, bateu, resumo)
  values (
    v_ini, p_arquivo_nome, v_qtd_prime, v_qtd_sistema,
    v_tot_p_vp, v_tot_p_vh, v_tot_s_vp, v_tot_s_vh,
    v_qtd_sp, v_qtd_ss, v_qtd_dv, round(v_tot_s_vp - v_tot_p_vp,2), round(v_tot_s_vh - v_tot_p_vh,2), v_bateu,
    jsonb_build_object('resumo_por_operador', v_resumo_op,
                       'qtd_so_prime', v_qtd_sp, 'qtd_so_sistema', v_qtd_ss, 'qtd_divergente', v_qtd_dv))
  returning id into v_id;

  return v_res || jsonb_build_object('conferencia_id', v_id);
end;
$function$;

-- ----------------------------------------------------------------------------
-- RPC: historico das conferencias (para a aba mostrar o que ja foi rodado).
-- ----------------------------------------------------------------------------
create or replace function public.fechamento_conferencia_listar(
  p_competencia date default null
) returns jsonb
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare v jsonb;
begin
  perform public.fechamento_exigir_acesso('listar_conferencias');
  select coalesce(jsonb_agg(to_jsonb(f) order by f.competencia desc, f.criado_em desc), '[]'::jsonb)
    into v
  from public.fechamento_conferencia_prime f
  where p_competencia is null or f.competencia = date_trunc('month', p_competencia)::date;
  return v;
end;
$function$;

revoke all on function public.fechamento_conferir_prime(date, text, jsonb) from public, anon;
revoke all on function public.fechamento_conferencia_listar(date) from public, anon;
grant execute on function public.fechamento_conferir_prime(date, text, jsonb) to authenticated;
grant execute on function public.fechamento_conferencia_listar(date) to authenticated;
