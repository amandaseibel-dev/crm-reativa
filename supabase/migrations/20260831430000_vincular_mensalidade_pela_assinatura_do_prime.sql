-- A mensalidade encontra o acordo pela assinatura do Prime.
--
-- Amanda, 31/08: "mensalidade quita e vira acordo, correto? nao existe algum
-- campo que possamos localizar?" e, decisiva, **"pago normal nao deve estar no
-- nosso portador"**. Depois: "precisamos localizar primeiro as mensalidades
-- negociadas, importar o acordo e baixar".
--
-- A CHAVE, validada 8 de 8 em 31/08:
--
--     mensalidade no portador 195 (ReATIVA Recuperacao de Creditos) com
--     paymentDate NAO foi paga -- foi NEGOCIADA. E as que dividem a MESMA
--     paymentDate pertencem ao MESMO acordo.
--
-- Pagamento de verdade cai em OUTRO portador: 95, 160, 177. Caso didatico,
-- Charles Manolo de Morais (matricula 101003443, acordo 3671):
--
--     4107296  venc 20/12/25  pago 08/12/25   portador 160  <- pagamento real
--     4108564  venc 05/01/26  "pago" 28/08/26 portador 195  <- NEGOCIADA
--     4108565  venc 05/02/26  "pago" 28/08/26 portador 195  <- NEGOCIADA
--     4108566  venc 05/03/26  "pago" 28/08/26 portador 195  <- NEGOCIADA
--     4108567  venc 05/04/26  pago 07/04/26   portador 95   <- pagamento real
--
-- ARMADILHA DE DATA: a negociacao acontece na Ulbra e o acordo entra no CRM
-- DIAS DEPOIS -- no Charles, 28/08 contra 31/08. Casar por PROXIMIDADE (acordo
-- criado depois da negociacao, dentro da tolerancia), nunca por igualdade.
--
-- NAO SERVEM: `isAgreementInstallment` vem false em tudo, `/agreements` vem
-- vazio, e `paidAmount` vem ~2x o `netAmount` ate em pagamento normal.
--
-- MEDIDO com apenas 55 dos 2.319 alunos coletados: 132 grupos de negociacao,
-- 33 casados com acordo, 33 titulos a vincular (R$ 30.787,77, 14 alunos).
-- Na proporcao, os 2.319 devem render ~1.400 titulos -- coerente com os 1.342
-- acordos hoje sem mensalidade vinculada.
--
-- NASCE DESLIGADA no fluxo: vincular tira mensalidade do saldo.

create table if not exists public.prime_extrato (
  matricula text not null, boleto text not null, cpf text,
  vencimento date, liquidado_em date,
  valor_liquido numeric, valor_pago numeric, honorario numeric,
  de_acordo boolean, portador int, portador_nome text,
  coletado_em timestamptz not null default now(),
  primary key (matricula, boleto)
);
alter table public.prime_extrato enable row level security;
drop policy if exists prime_extrato_gestao on public.prime_extrato;
create policy prime_extrato_gestao on public.prime_extrato
  for select to authenticated using (public.usuario_e_gestao());
create index if not exists ix_prime_extrato_boleto on public.prime_extrato (boleto);
create index if not exists ix_prime_extrato_negociacao
  on public.prime_extrato (matricula, portador, liquidado_em)
  where portador = 195 and liquidado_em is not null;

create table if not exists public.prime_extrato_fila (
  matricula text primary key, cpf text, motivo text,
  tentativas int not null default 0, ultimo_erro text,
  coletado_em timestamptz, criado_em timestamptz not null default now()
);
alter table public.prime_extrato_fila enable row level security;
drop policy if exists prime_fila_gestao on public.prime_extrato_fila;
create policy prime_fila_gestao on public.prime_extrato_fila
  for select to authenticated using (public.usuario_e_gestao());

create or replace function public.prime_extrato_ok(p_matricula text)
returns void language sql security definer set search_path to 'public' as $$
  update public.prime_extrato_fila set coletado_em = now(), ultimo_erro = null
   where matricula = p_matricula;
$$;
create or replace function public.prime_extrato_falhou(p_matricula text, p_erro text)
returns void language sql security definer set search_path to 'public' as $$
  update public.prime_extrato_fila
     set tentativas = tentativas + 1, ultimo_erro = left(coalesce(p_erro,''),200)
   where matricula = p_matricula;
$$;
revoke all on function public.prime_extrato_ok(text) from public, anon, authenticated;
revoke all on function public.prime_extrato_falhou(text,text) from public, anon, authenticated;
grant execute on function public.prime_extrato_ok(text) to service_role;
grant execute on function public.prime_extrato_falhou(text,text) to service_role;

create or replace function public.prime_extrato_mutirao()
returns bigint language plpgsql security definer set search_path to 'public' as $$
declare v_url text; v_req bigint; v_carga jsonb; v_faltam int;
begin
  select count(*) into v_faltam from public.prime_extrato_fila
   where coletado_em is null and tentativas < 3;
  if coalesce(v_faltam,0) = 0 then return null; end if;
  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean,false) then return null; end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name='projeto_url';
  if v_url is null then return null; end if;
  select net.http_post(
    url := rtrim(v_url,'/') || '/functions/v1/prime-extrato',
    headers := jsonb_build_object('Content-Type','application/json'),
    body := jsonb_build_object('lote', 400),
    timeout_milliseconds := 170000
  ) into v_req;
  return v_req;
end $$;
revoke all on function public.prime_extrato_mutirao() from public, anon;
grant execute on function public.prime_extrato_mutirao() to service_role;

select cron.schedule('prime_extrato_mutirao','*/2 * * * *','select public.prime_extrato_mutirao();');

insert into public.fluxo_pagamentos_config (etapa, ligado, observacao) values
  ('vincular_por_negociacao', false,
   'DESLIGADA ate a coleta terminar: liga a mensalidade ao acordo pela assinatura do portador 195. Tira mensalidade do saldo.')
on conflict (etapa) do update set observacao = excluded.observacao;
