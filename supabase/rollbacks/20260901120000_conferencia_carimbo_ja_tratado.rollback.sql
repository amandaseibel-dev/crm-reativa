-- Volta a decisao a aceitar so CONFIRMADO/REJEITADO/QUITADO.
-- ATENCAO: se ja houver linhas JA_TRATADO, a constraint nao entra. Converta-as
-- antes (para CONFIRMADO) ou apague-as, conscientemente.
delete from public.conciliacao_pagamento_conferido where decisao = 'JA_TRATADO';
delete from public.conciliacao_santander_decisao where decisao = 'JA_TRATADO';

alter table public.conciliacao_santander_decisao
  drop constraint if exists conciliacao_santander_decisao_decisao_check;
alter table public.conciliacao_santander_decisao
  add constraint conciliacao_santander_decisao_decisao_check
  check (decisao = any (array['CONFIRMADO','REJEITADO','QUITADO']));

create or replace function public.conciliacao_santander_decidir(
  p_aluno_id uuid, p_decisao text, p_motivo text default null,
  p_valor numeric default null, p_desde date default date '2026-07-01'
) returns jsonb
language plpgsql security definer
set search_path to 'public'
as $$
declare v_email text := lower(coalesce(auth.jwt()->>'email','')); v_n int;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;
  if upper(coalesce(p_decisao,'')) not in ('CONFIRMADO','REJEITADO','QUITADO') then
    raise exception 'Decisao invalida: use CONFIRMADO, REJEITADO ou QUITADO.';
  end if;
  if upper(p_decisao) = 'REJEITADO' and coalesce(btrim(p_motivo),'') = '' then
    raise exception 'Motivo obrigatorio para rejeitar.';
  end if;

  insert into public.conciliacao_santander_decisao
    (aluno_id, decisao, motivo, valor_considerado, decidido_por)
  values (p_aluno_id, upper(p_decisao), nullif(btrim(coalesce(p_motivo,'')),''), p_valor, v_email)
  on conflict (aluno_id) do update
     set decisao = excluded.decisao, motivo = excluded.motivo,
         valor_considerado = excluded.valor_considerado,
         decidido_por = excluded.decidido_por, decidido_em = now();

  insert into public.conciliacao_pagamento_conferido (pagamento_id, aluno_id, decisao, conferido_por)
  select p.id, p.aluno_id, upper(p_decisao), v_email
    from public.pagamentos p
   where p.aluno_id = p_aluno_id and p.data_pagamento >= p_desde
  on conflict (pagamento_id) do update
     set decisao = excluded.decisao, conferido_por = excluded.conferido_por, conferido_em = now();
  get diagnostics v_n = row_count;

  return jsonb_build_object('ok', true, 'aluno_id', p_aluno_id,
                            'decisao', upper(p_decisao), 'pagamentos_conferidos', v_n);
end;
$$;
