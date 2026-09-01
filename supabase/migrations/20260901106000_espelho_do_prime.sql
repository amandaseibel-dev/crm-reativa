-- Amanda, 31/08: "um conceito que voce tem que ter e usar o prime como banco
-- de dados, crm o espelho, essa e a premissa".
--
-- Espelho local do extrato financeiro do Prime, coletado aluno a aluno pela
-- edge function `prime-extrato` (GET /students/{matricula}, campo
-- financialStatement). Guarda o boleto com principal, juros, multa, desconto e
-- honorario separados -- o Prime devolve tudo decomposto, e o CRM nao tinha.
--
-- ATENCAO -- LIMITES MEDIDOS, para ninguem repetir o erro:
--   * `paymentDate` vem preenchido em 100% dos titulos, inclusive nos que
--     estao em aberto. NAO serve para distinguir pago de negociado --
--     ver [[portador-195-com-data-igual-e-negociacao]] (regra INVALIDADA).
--   * `paidAmount` vem por volta do dobro do liquido mesmo em pagamento
--     normal; e inutilizavel. Use valor_bruto.
--   * `agreements` volta vazio e `isAgreementInstallment` e sempre false: o
--     Prime NAO diz quais mensalidades compoem um acordo --
--     ver [[prime-nao-enxerga-o-acordo]].
--
-- PORTADORES: so 195 (ReATIVA Recuperacao de Credito) e 166 (Santander
-- ReATIVA) sao nossos. Amanda: "nunca pegue todos os portadores, somente os
-- que mencionei acima" -- ver [[prime-so-portadores-166-e-195]].
--
-- A chave da API da Ulbra da acesso a CPF e dados financeiros de ~400 mil
-- pessoas: vive so no Vault, nunca no navegador, nunca no repositorio.

create table if not exists public.prime_extrato (
  matricula      text not null,
  boleto         text not null,
  cpf            text,
  vencimento     date,
  liquidado_em   date,
  valor_bruto    numeric,
  valor_liquido  numeric,
  valor_pago     numeric,
  desconto       numeric,
  multa          numeric,
  juros          numeric,
  honorario      numeric,
  de_acordo      boolean,
  portador       integer,
  portador_nome  text,
  coletado_em    timestamptz not null default now(),
  primary key (matricula, boleto)
);
create index if not exists ix_prime_extrato_boleto on public.prime_extrato (boleto);
create index if not exists ix_prime_extrato_boleto_mat on public.prime_extrato (boleto, matricula);

create table if not exists public.prime_extrato_fila (
  matricula    text primary key,
  cpf          text,
  motivo       text,
  tentativas   integer not null default 0,
  ultimo_erro  text,
  coletado_em  timestamptz,
  criado_em    timestamptz not null default now()
);

alter table public.prime_extrato enable row level security;
alter table public.prime_extrato_fila enable row level security;

-- As DUAS camadas: a tabela concede SELECT a authenticated, e a politica de RLS
-- estreita esse SELECT para a gestao. Revogar o SELECT aqui deixaria a politica
-- sem nada para liberar e a gestao sem enxergar o espelho.
revoke all on public.prime_extrato, public.prime_extrato_fila from anon;
grant select on public.prime_extrato, public.prime_extrato_fila to authenticated;

drop policy if exists prime_extrato_gestao on public.prime_extrato;
create policy prime_extrato_gestao on public.prime_extrato
  for select to authenticated using (public.usuario_e_gestao());

drop policy if exists prime_fila_gestao on public.prime_extrato_fila;
create policy prime_fila_gestao on public.prime_extrato_fila
  for select to authenticated using (public.usuario_e_gestao());

-- A chave da Ulbra nao chega as edge functions novas pelo secret; sai do Vault
-- e SO para service_role.
create or replace function public.prime_chave_api()
returns text language plpgsql security definer set search_path to 'public'
as $function$
declare v text;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Acesso negado.' using errcode='42501';
  end if;
  select decrypted_secret into v from vault.decrypted_secrets where name='prime_api_key';
  return v;
end;
$function$;

revoke all on function public.prime_chave_api() from public, anon, authenticated;
grant execute on function public.prime_chave_api() to service_role;

-- Mutirao: chama a edge function em lotes enquanto houver fila. Sai na hora
-- quando nao ha nada a coletar ou quando o sistema esta sob carga -- nao
-- concorre com a operacao.
create or replace function public.prime_extrato_mutirao()
returns bigint language plpgsql security definer set search_path to 'public'
as $function$
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
    body := jsonb_build_object('lote', 60),
    timeout_milliseconds := 170000) into v_req;
  return v_req;
end;
$function$;

-- Lista de quem esta em cada portador. A troca de portador e MANUAL: quando a
-- equipe negocia, move o aluno do 195 para o 166. Sem as duas listas frescas
-- nao da para saber quem negociou e ninguem trocou.
create or replace function public.prime_portador_mutirao()
returns bigint language plpgsql security definer set search_path to 'public'
as $function$
declare v_url text; v_token text; v_req bigint; v_portador int; v_carga jsonb;
begin
  select decrypted_secret into v_url   from vault.decrypted_secrets where name='projeto_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name='prime_cadastro_token';
  if v_url is null or v_token is null then return null; end if;

  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean, false) then return null; end if;

  -- alterna 166 e 195, sempre atras do mais desatualizado
  select portador into v_portador
    from (select 166 portador union all select 195) p
    left join lateral (select max(coletado_em) ult from public.prime_portador_membro m
                        where m.portador = p.portador) u on true
   order by coalesce(u.ult, timestamptz '2000-01-01') asc limit 1;

  select net.http_post(
    url := rtrim(v_url,'/') || '/functions/v1/prime-portador',
    headers := jsonb_build_object('Content-Type','application/json','x-rotina-token', v_token),
    body := jsonb_build_object('portador', v_portador),
    timeout_milliseconds := 170000) into v_req;

  return v_req;
end;
$function$;

revoke all on function public.prime_extrato_mutirao() from public, anon, authenticated;
revoke all on function public.prime_portador_mutirao() from public, anon, authenticated;
grant execute on function public.prime_extrato_mutirao() to service_role;
grant execute on function public.prime_portador_mutirao() to service_role;
