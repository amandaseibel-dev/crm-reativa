-- Regressão: acesso do PDF = acesso da tela, na versão corrigida.
create or replace function pg_temp.pdf(p_email text, p_mes text) returns jsonb
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('email', p_email, 'role', 'authenticated')::text, true);
  return public.projecao_relatorio_pdf(p_mes);
end $$;

do $$
declare
  m text := to_char(current_date,'YYYY-MM');
  d jsonb; g jsonb; o jsonb; v jsonb; sum_evo numeric; sum_dia numeric;
begin
  -- 1. Diretoria: consolidado, sem ranking/unidade/nome de operador.
  d := pg_temp.pdf('diretoria.sintetica@teste.local', m);
  if d->>'e_diretoria' <> 'true' or d->>'e_gestao' <> 'false' then raise exception 'REGRESSÃO: perfil da diretoria'; end if;
  if (d->'total'->>'pagamentos')::bigint <> 3 or (d->'total'->>'recuperado')::numeric <> 450 then
    raise exception 'REGRESSÃO: diretoria sem consolidado: %', d->'total'; end if;
  if jsonb_array_length(d->'por_operador') <> 0 or jsonb_array_length(d->'por_unidade') <> 0 then
    raise exception 'VAZAMENTO: diretoria recebeu ranking/unidade'; end if;
  if d->>'operador_nome' is not null then raise exception 'VAZAMENTO: diretoria recebeu nome de operador'; end if;

  -- 2. Gestão: mantém ranking e unidade.
  g := pg_temp.pdf('amanda.seibel@aelbra.com.br', m);
  if g->>'e_gestao' <> 'true' then raise exception 'REGRESSÃO: gestão sem e_gestao'; end if;
  if jsonb_array_length(g->'por_operador') <> 2 then raise exception 'REGRESSÃO: gestão sem ranking'; end if;
  if (g->'total'->>'recuperado')::numeric <> 450 then raise exception 'REGRESSÃO: gestão ≠ consolidado'; end if;

  -- 3. Operador: só os próprios (100+50=150; sem a retroativa de 999).
  o := pg_temp.pdf('operador.sintetico@teste.local', m);
  if o->>'e_diretoria' <> 'false' or o->>'e_gestao' <> 'false' then raise exception 'VAZAMENTO: perfil elevado'; end if;
  if (o->'total'->>'recuperado')::numeric <> 150 or (o->'total'->>'pagamentos')::bigint <> 2 then
    raise exception 'VAZAMENTO/REGRESSÃO: operador vê %', o->'total'; end if;
  if jsonb_array_length(o->'por_operador') <> 0 then raise exception 'VAZAMENTO: operador viu ranking'; end if;

  -- 4. Coerência interna do PDF (mesma base): evolução e dias batem com o total.
  select coalesce(sum((x->>'recuperado')::numeric),0) into sum_evo from jsonb_array_elements(d->'evolucao') x;
  select coalesce(sum((x->>'recuperado')::numeric),0) into sum_dia from jsonb_array_elements(d->'dias_maior') x;
  if sum_evo <> (d->'total'->>'recuperado')::numeric then raise exception 'DIVERGÊNCIA: evolução ≠ total'; end if;
  if sum_dia > (d->'total'->>'recuperado')::numeric then raise exception 'DIVERGÊNCIA: dias > total'; end if;

  -- 5. Ausência legítima: mês sem pagamentos não é erro.
  v := pg_temp.pdf('diretoria.sintetica@teste.local', '2099-01');
  if v->>'sem_pagamentos' <> 'true' then raise exception 'REGRESSÃO: mês vazio não sinalizado'; end if;

  -- 6. Bloqueios: anônimo, não cadastrado e inativo.
  begin
    perform set_config('request.jwt.claims', '{}', true);
    perform public.projecao_relatorio_pdf(m);
    raise exception 'VAZAMENTO: anônimo passou';
  exception when sqlstate '42501' then null; end;
  begin
    perform pg_temp.pdf('nao.cadastrado@teste.local', m);
    raise exception 'VAZAMENTO: não cadastrado passou';
  exception when sqlstate '42501' then null; end;
  begin
    perform pg_temp.pdf('inativo.sintetico@teste.local', m);
    raise exception 'VAZAMENTO: inativo passou';
  exception when sqlstate '42501' then null; end;

  raise notice 'OK depois: diretoria/gestão/operador/ausência/bloqueios conforme a tela.';
end $$;
