-- Rejeitar em lote na Conferencia Prime.
--
-- Sao 2.263 titulos liquidados no Prime SEM nenhum pagamento no Santander --
-- negociacao, nao pagamento. Rejeitar um por um seria 1.202 cliques (o numero
-- de alunos). Sem isto a gestao simplesmente nao limpa a fila.
--
-- REJEITAR NAO MEXE EM DINHEIRO: nao baixa titulo, nao altera saldo, nao tira
-- ninguem da carteira. So registra "conferi e a divida e real" e tira o titulo
-- da fila de conferencia. Por isso o lote e seguro -- o contrario (baixar em
-- lote) continua sendo um titulo por vez, de proposito.

create or replace function public.prime_conferencia_rejeitar_lote(
  p_titulo_ids uuid[], p_motivo text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '120s'
as $$
declare
  v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_n int;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Conferencia Prime e decisao da gestao.' using errcode = '42501';
  end if;

  if p_titulo_ids is null or array_length(p_titulo_ids, 1) is null then
    return jsonb_build_object('ok', false, 'motivo', 'LISTA_VAZIA');
  end if;

  insert into public.prime_conferencia_decisao (titulo_id, decisao, motivo, decidido_por)
  select t, 'REJEITADO', nullif(trim(coalesce(p_motivo,'')),''), nullif(v_email,'')
    from unnest(p_titulo_ids) as t
  on conflict (titulo_id) do update
    set decisao = 'REJEITADO', motivo = excluded.motivo,
        decidido_por = excluded.decidido_por, decidido_em = now();

  get diagnostics v_n = row_count;
  return jsonb_build_object('ok', true, 'rejeitados', v_n);
end;
$$;

revoke all on function public.prime_conferencia_rejeitar_lote(uuid[], text) from public, anon;
grant execute on function public.prime_conferencia_rejeitar_lote(uuid[], text) to authenticated, service_role;
