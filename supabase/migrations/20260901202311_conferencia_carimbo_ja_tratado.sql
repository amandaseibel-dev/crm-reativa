-- CARIMBAR "JA TRATADO" sem criar baixa nenhuma.
--
-- Amanda, 01/09/2026: "existe uma forma de carimbar que o caso ja foi tratado?
-- tipo cartao, eu baixo no Prime e ja baixo no CRM, ok, ja esta tratado".
--
-- O BURACO: a Confirmacao de Pagamento tem UM caminho so para tirar alguem da
-- fila -- o botao "Feito" -- e ele sempre chama `conferencia_baixar_do_extrato`,
-- que REGISTRA UMA BAIXA. Para quem ja foi baixado por fora (cartao no Prime,
-- baixa feita na ficha) isso e baixa em dobro: aquela funcao so ignora repetido
-- quando aluno, data E valor batem exatamente, e o valor que a fila manda e a
-- SOMA dos pagamentos da janela -- quase nunca igual a baixa feita a mao.
--
-- Sem esta saida, a alternativa era deixar a pessoa na fila para sempre ou
-- aceitar a baixa duplicada. Nenhuma das duas serve.
--
-- O QUE MUDA: `conciliacao_santander_decidir` passa a aceitar a decisao
-- JA_TRATADO, com motivo OBRIGATORIO (igual REJEITADO -- carimbo sem
-- justificativa vira jeito de esconder). Ela ja nao mexe em dinheiro: grava a
-- decisao e marca os pagamentos como conferidos. Fica gravado com nome proprio
-- para depois dar para separar "conferi eu aqui" de "ja estava resolvido".
--
-- `conciliacao_santander_desfazer` continua desfazendo, sem mudanca.
--
-- DESFAZER: supabase/rollbacks/20260901120000_conferencia_carimbo_ja_tratado.rollback.sql

alter table public.conciliacao_santander_decisao
  drop constraint if exists conciliacao_santander_decisao_decisao_check;
alter table public.conciliacao_santander_decisao
  add constraint conciliacao_santander_decisao_decisao_check
  check (decisao = any (array['CONFIRMADO','REJEITADO','QUITADO','JA_TRATADO']));

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
  if upper(coalesce(p_decisao,'')) not in ('CONFIRMADO','REJEITADO','QUITADO','JA_TRATADO') then
    raise exception 'Decisao invalida: use CONFIRMADO, REJEITADO, QUITADO ou JA_TRATADO.';
  end if;
  -- Motivo obrigatorio nas duas decisoes que tiram da fila SEM registrar nada.
  if upper(p_decisao) in ('REJEITADO','JA_TRATADO') and coalesce(btrim(p_motivo),'') = '' then
    raise exception 'Motivo obrigatorio para % .', upper(p_decisao);
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

revoke all on function public.conciliacao_santander_decidir(uuid, text, text, numeric, date) from public, anon;
grant execute on function public.conciliacao_santander_decidir(uuid, text, text, numeric, date) to authenticated, service_role;
