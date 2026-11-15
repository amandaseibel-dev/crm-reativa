-- CASOS. Cada falha levanta exceção e derruba o job (ON_ERROR_STOP).
create or replace function pg_temp.espera_negado(p_sem text, p_motivo text) returns void
language plpgsql as $$
begin
  perform public.efetividade_caixa_resumo_semestre(p_sem);
  raise exception 'FALHA [%]: deveria ter sido negado', p_motivo;
exception when sqlstate '42501' then
  null; -- negado como esperado
end $$;

-- 1. anon: sem EXECUTE. Falha de permissão do Postgres (42501), antes da função.
set role anon;
select set_config('request.jwt.claims', '', false);
do $$ begin
  begin perform public.efetividade_caixa_resumo_semestre('2026/2');
        raise exception 'FALHA [anon]: executou';
  exception when insufficient_privilege then null; end;
end $$;
reset role;

-- 2. authenticated sem e-mail na sessão: negado pelo portão.
set role authenticated;
select set_config('request.jwt.claims', '{}', false);
select pg_temp.espera_negado('2026/2', 'authenticated sem e-mail');

-- 3. diretoria ativa, fora da gestão: NEGADO (diretoria não entra por este caminho).
select set_config('request.jwt.claims', '{"email":"angela.ferreira@aelbra.com.br"}', false);
select pg_temp.espera_negado('2026/2', 'diretoria ativa');

-- 4. gestão na lista MAS inativa em usuarios: negado.
select set_config('request.jwt.claims', '{"email":"cobranca07@aelbra.com.br"}', false);
select pg_temp.espera_negado('2026/2', 'gestão inativa');

-- 5. semestre inválido: erro 22023 mesmo para gestão autorizada.
select set_config('request.jwt.claims', '{"email":"amanda.seibel@aelbra.com.br"}', false);
do $$ begin
  begin perform public.efetividade_caixa_resumo_semestre('2030/1');
        raise exception 'FALHA [semestre inválido]';
  exception when sqlstate '22023' then null; end;
end $$;

-- 6. gestão ativa 2026/2: agregados corretos, sem dado pessoal.
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
  if (s->>'carteira_original')::numeric <> 2100 then raise exception 'FALHA carteira 2026/2: %', s->>'carteira_original'; end if;
  if (s->>'saldo_em_aberto_total')::numeric <> 950 then raise exception 'FALHA saldo total (cancelado excluído): %', s->>'saldo_em_aberto_total'; end if;
  if (s->>'saldo_em_conferencia')::numeric <> 100 then raise exception 'FALHA conferência'; end if;
  if (s->>'saldo_academico')::numeric <> 50 then raise exception 'FALHA acadêmico'; end if;
  if (s->>'saldo_sem_pendencia')::numeric <> 800 then raise exception 'FALHA sem pendência'; end if;
  if (s->>'saldo_acordos_ativos')::numeric <> 200 then raise exception 'FALHA acordos ativos'; end if;
  -- Nenhuma chave de identificação individual pode existir na saída.
  if r::text ~* '(cpf|aluno_id|titulo_id|acordo_id|pagamento_id|documento|nome)' then
    raise exception 'FALHA: dado pessoal/individual na saída';
  end if;
end $$;

-- 7. regressão 2026/1: caixa próprio, sem bloco de saldo de 2026/2.
do $$
declare r jsonb;
begin
  r := public.efetividade_caixa_resumo_semestre('2026/1');
  if (r->>'caixa_confirmado')::numeric <> 10 then raise exception 'FALHA regressão 2026/1 caixa'; end if;
  if (r->>'pagamentos_confirmados')::int <> 1 then raise exception 'FALHA regressão 2026/1 qtd'; end if;
  if r->'saldo_2026_2' <> 'null'::jsonb then raise exception 'FALHA: 2026/1 não deveria trazer saldo 2026/2'; end if;
end $$;

-- 8. grants: authenticated executa, anon não.
select has_function_privilege('authenticated', 'public.efetividade_caixa_resumo_semestre(text)', 'EXECUTE') as auth_ok \gset
select has_function_privilege('anon', 'public.efetividade_caixa_resumo_semestre(text)', 'EXECUTE') as anon_ok \gset
\if :auth_ok
\else
  \echo FALHA: authenticated sem EXECUTE
  \quit 1
\endif
\if :anon_ok
  \echo FALHA: anon com EXECUTE
  \quit 1
\endif
reset role;
\echo OK efetividade_caixa_resumo_semestre: todos os casos passaram
