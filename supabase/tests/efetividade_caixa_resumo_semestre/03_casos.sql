-- CASOS. Cada falha levanta exceção (P0001) e derruba o job com ON_ERROR_STOP.
create or replace function pg_temp.espera_negado(p_sem text, p_motivo text) returns void
language plpgsql as $$
begin
  perform public.efetividade_caixa_resumo_semestre(p_sem);
  raise exception 'FALHA [%]: deveria ter sido negado', p_motivo;
exception when sqlstate '42501' then
  null; -- negado como esperado
end $$;

create or replace function pg_temp.espera_ok(p_email text, p_motivo text) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('email', p_email)::text, false);
  perform public.efetividade_caixa_resumo_semestre('2026/2');
exception when sqlstate '42501' then
  raise exception 'FALHA [%]: gestão autorizada foi negada', p_motivo;
end $$;

-- 1. anon: sem EXECUTE. Falha de permissão do Postgres antes da função.
set role anon;
select set_config('request.jwt.claims', '', false);
do $$ begin
  begin perform public.efetividade_caixa_resumo_semestre('2026/2');
        raise exception 'FALHA [anon]: executou';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- 2..5 authenticated com diferentes sessões.
set role authenticated;
select pg_temp.espera_negado('2026/2', 'authenticated sem e-mail')
  from (select set_config('request.jwt.claims', '{}', false)) x;

-- diretoria ativa, fora da gestão: negada.
select set_config('request.jwt.claims', '{"email":"angela.ferreira@aelbra.com.br"}', false);
select pg_temp.espera_negado('2026/2', 'diretoria ativa');

-- operador comum ativo, fora da gestão: negado.
select set_config('request.jwt.claims', '{"email":"operador@aelbra.com.br"}', false);
select pg_temp.espera_negado('2026/2', 'operador comum');

-- gestão na lista mas inativa em usuarios: negada.
select set_config('request.jwt.claims', '{"email":"cobranca07@aelbra.com.br"}', false);
select pg_temp.espera_negado('2026/2', 'gestão inativa');

-- 6. gestão ativa (duas contas): autorizadas.
select pg_temp.espera_ok('amanda.seibel@aelbra.com.br', 'gestão ativa amanda');
select pg_temp.espera_ok('cobranca04@aelbra.com.br', 'gestão ativa cobranca04');

-- 7. semestre inválido, mesmo para gestão autorizada: 22023.
select set_config('request.jwt.claims', '{"email":"amanda.seibel@aelbra.com.br"}', false);
do $$ begin
  begin perform public.efetividade_caixa_resumo_semestre('2030/1');
        raise exception 'FALHA [semestre inválido]';
  exception when sqlstate '22023' then null; end;
end $$;

-- 8. agregados de 2026/2 e percentual calculado no banco.
do $$
declare r jsonb; s jsonb;
begin
  r := public.efetividade_caixa_resumo_semestre('2026/2');
  s := r->'saldo_2026_2';
  if (r->>'caixa_confirmado')::numeric <> 100 then raise exception 'FALHA caixa 2026/2: %', r->>'caixa_confirmado'; end if;
  if (r->>'pagamentos_confirmados')::int <> 2 then raise exception 'FALHA qtd caixa 2026/2'; end if;
  if (r->>'pendente_classificacao')::numeric <> 50 then raise exception 'FALHA pendente 2026/2'; end if;
  if (r->>'pagamentos_pendentes')::int <> 1 then raise exception 'FALHA qtd pendentes 2026/2'; end if;
  if (r->>'sem_origem_determinada')::numeric <> 30 then raise exception 'FALHA sem origem'; end if;
  if (r->>'carteira_original')::numeric <> 2100 then raise exception 'FALHA carteira 2026/2: %', r->>'carteira_original'; end if;
  if (r->>'titulos_carteira')::int <> 5 then raise exception 'FALHA títulos 2026/2'; end if;
  if (r->>'carteira_fonte') <> 'classificador_2026_2' then raise exception 'FALHA fonte 2026/2'; end if;
  -- 100 / 2100 = 4,8%. Percentual calculado no banco, não na tela.
  if (r->>'percentual_recuperado_caixa')::numeric <> 4.8 then raise exception 'FALHA percentual: %', r->>'percentual_recuperado_caixa'; end if;
  if (s->>'saldo_em_aberto_total')::numeric <> 950 then raise exception 'FALHA saldo total (cancelado excluído): %', s->>'saldo_em_aberto_total'; end if;
  if (s->>'saldo_em_conferencia')::numeric <> 100 then raise exception 'FALHA conferência'; end if;
  if (s->>'saldo_academico')::numeric <> 50 then raise exception 'FALHA acadêmico'; end if;
  if (s->>'saldo_acordos_ativos')::numeric <> 200 then raise exception 'FALHA acordos ativos'; end if;
  if (r->>'saldo_em_aberto')::numeric <> 950 then raise exception 'FALHA saldo_em_aberto 2026/2'; end if;
  if (r->>'negociado')::numeric <> 400 then raise exception 'FALHA negociado 2026/2'; end if;
  if (r->>'fotografia_atualizacao_pendente') is not null then raise exception 'FALHA: 2026/2 não usa fotografia'; end if;
  -- Nenhuma chave de identificação individual pode existir na saída.
  if r::text ~* '(cpf|aluno_id|titulo_id|acordo_id|pagamento_id|documento|nome)' then
    raise exception 'FALHA: dado pessoal/individual na saída';
  end if;
end $$;

-- 9. regressão 2026/1: caixa próprio, carteira da fotografia, sem bloco de 2026/2.
do $$
declare r jsonb;
begin
  r := public.efetividade_caixa_resumo_semestre('2026/1');
  if (r->>'caixa_confirmado')::numeric <> 10 then raise exception 'FALHA regressão 2026/1 caixa'; end if;
  if (r->>'pagamentos_confirmados')::int <> 1 then raise exception 'FALHA regressão 2026/1 qtd'; end if;
  if (r->>'carteira_original')::numeric <> 1000 then raise exception 'FALHA carteira 2026/1'; end if;
  if (r->>'percentual_recuperado_caixa')::numeric <> 1.0 then raise exception 'FALHA percentual 2026/1'; end if;
  if (r->>'saldo_em_aberto')::numeric <> 600 then raise exception 'FALHA saldo_em_aberto 2026/1'; end if;
  if (r->>'fotografia_atualizacao_pendente')::boolean is not true then raise exception 'FALHA: 2026/1 sem sinal de defasagem'; end if;
  if (r->>'fotografia_gerada_em') is null then raise exception 'FALHA: 2026/1 sem data da fotografia'; end if;
  if (r->>'negociado')::numeric <> 200 then raise exception 'FALHA negociado 2026/1'; end if;
  if r->'saldo_2026_2' <> 'null'::jsonb then raise exception 'FALHA: 2026/1 não deveria trazer saldo 2026/2'; end if;
end $$;

-- 10a. volatilidade declarada (não pode ser STABLE com escrita possível).
do $$ begin
  if (select provolatile from pg_proc where oid = 'public.efetividade_caixa_resumo_semestre(text)'::regprocedure) <> 'v' then
    raise exception 'FALHA: RPC deve ser VOLATILE';
  end if;
end $$;

-- 10. grants: authenticated tem EXECUTE; anon não. Falha explícita, sem \quit.
do $$
begin
  if not has_function_privilege('authenticated', 'public.efetividade_caixa_resumo_semestre(text)', 'EXECUTE') then
    raise exception 'FALHA: authenticated sem EXECUTE';
  end if;
  if has_function_privilege('anon', 'public.efetividade_caixa_resumo_semestre(text)', 'EXECUTE') then
    raise exception 'FALHA: anon com EXECUTE';
  end if;
end $$;
reset role;
select 'OK efetividade_caixa_resumo_semestre: todos os casos passaram' as resultado;
