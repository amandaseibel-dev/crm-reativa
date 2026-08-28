-- Conferencia Prime: decisao da gestao, titulo por titulo.
--
-- A tela existia no codigo (src/pages/ConferenciaPrime.jsx) mas NUNCA foi
-- ligada -- sem import, sem rota, sem menu. E a consulta dela nao olhava o
-- portador, que e a peca que decide:
--   195 = mensalidade em cobranca (AINDA DEVE)
--   166 = saiu da cobranca (negociou ou pagou)
-- Sem isso a lista mostrava R$ 28 mi sugerindo baixa de divida viva. Medido:
-- 34.043 titulos da fila estao no portador 195.
--
-- Em vez de esconder, o portador vira INFORMACAO no card: quem decide e a
-- gestao, e decide melhor vendo o sinal. Cada titulo recebe CONFIRMADO (da a
-- baixa pela funcao que ja existia) ou REJEITADO (nao baixa e sai da fila), e
-- a decisao fica registrada com autor, data e motivo.

create table if not exists public.prime_conferencia_decisao (
  titulo_id   uuid primary key references public.acordos_titulos(id) on delete cascade,
  decisao     text not null check (decisao in ('CONFIRMADO','REJEITADO')),
  motivo      text,
  decidido_por text,
  decidido_em timestamptz not null default now()
);

alter table public.prime_conferencia_decisao enable row level security;

drop policy if exists prime_conferencia_decisao_gestao on public.prime_conferencia_decisao;
create policy prime_conferencia_decisao_gestao on public.prime_conferencia_decisao
  for select using (coalesce(public.usuario_e_gestao(), false));

create or replace function public.prime_conferencia_fila()
returns table (
  titulo_id uuid, aluno_id uuid, aluno_nome text, cpf text, documento text,
  vencimento date, valor_em_aberto numeric, liquidado_em date,
  tem_acordo_ativo boolean, operador_responsavel text,
  portador int, portador_diz text
)
language sql
stable
security definer
set search_path to 'public'
set statement_timeout to '120s'
as $$
  select l.titulo_id, l.aluno_id, l.aluno_nome, l.cpf, l.documento,
         l.vencimento, l.valor_em_aberto, l.liquidado_em,
         l.tem_acordo_ativo, l.operador_responsavel,
         pt.carrier_id,
         case pt.carrier_id
           when 195 then 'Prime ainda cobra este título'
           when 166 then 'Prime tirou da cobrança'
           when null then 'Prime não informa o portador'
           else 'Portador ' || pt.carrier_id::text
         end
    from public.prime_conferencia_listar() l
    left join lateral (
      select p.carrier_id from public.prime_titulo_semestre p
       where p.boleto = l.documento limit 1
    ) pt on true
   where not exists (
     select 1 from public.prime_conferencia_decisao d where d.titulo_id = l.titulo_id
   );
$$;

revoke all on function public.prime_conferencia_fila() from public, anon;
grant execute on function public.prime_conferencia_fila() to authenticated, service_role;

create or replace function public.prime_conferencia_rejeitar(
  p_titulo_id uuid, p_motivo text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Conferencia Prime e decisao da gestao.' using errcode = '42501';
  end if;

  insert into public.prime_conferencia_decisao (titulo_id, decisao, motivo, decidido_por)
  values (p_titulo_id, 'REJEITADO', nullif(trim(coalesce(p_motivo,'')),''), nullif(v_email,''))
  on conflict (titulo_id) do update
    set decisao = 'REJEITADO', motivo = excluded.motivo,
        decidido_por = excluded.decidido_por, decidido_em = now();

  return jsonb_build_object('ok', true, 'decisao', 'REJEITADO');
end;
$$;

revoke all on function public.prime_conferencia_rejeitar(uuid, text) from public, anon;
grant execute on function public.prime_conferencia_rejeitar(uuid, text) to authenticated, service_role;

create or replace function public.prime_conferencia_confirmar(
  p_titulo_id uuid, p_observacao text default null)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare v_email text := lower(coalesce(auth.jwt() ->> 'email', '')); v_res jsonb;
begin
  v_res := public.prime_conferencia_baixar(p_titulo_id, p_observacao);

  insert into public.prime_conferencia_decisao (titulo_id, decisao, motivo, decidido_por)
  values (p_titulo_id, 'CONFIRMADO', nullif(trim(coalesce(p_observacao,'')),''), nullif(v_email,''))
  on conflict (titulo_id) do update
    set decisao = 'CONFIRMADO', motivo = excluded.motivo,
        decidido_por = excluded.decidido_por, decidido_em = now();

  return coalesce(v_res, '{}'::jsonb) || jsonb_build_object('ok', true, 'decisao', 'CONFIRMADO');
end;
$$;

revoke all on function public.prime_conferencia_confirmar(uuid, text) from public, anon;
grant execute on function public.prime_conferencia_confirmar(uuid, text) to authenticated, service_role;
