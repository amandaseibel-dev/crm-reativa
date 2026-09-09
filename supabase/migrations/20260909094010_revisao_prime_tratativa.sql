-- A REVISAO PRIME VIRA FILA DE TRABALHO, NAO SO RELATORIO.
--
-- ATENCAO: esta migration sustenta a tela src/pages/RevisaoPrime.jsx, que ja
-- esta na main (PR #332). Sem ela os botoes Feito/Rejeitar quebram.
--
-- A tela mostrava 671 alunos e R$ 2,36 milhoes de divergencia, e nao havia como
-- dizer o que ja foi olhado. Sem isso, toda semana a lista volta inteira e
-- ninguem sabe o que e novo.
--
-- DOIS DESFECHOS, com significados diferentes:
--   FEITO      -- a divergencia era real e foi tratada;
--   REJEITADO  -- nao era divergencia: o caso esta CERTO no Prime.
--
-- Guardar os dois separados importa: uma pilha de REJEITADO no mesmo padrao e
-- sinal de que a regra de DETECCAO precisa mudar, nao de trabalho devendo.
--
-- A tratativa e por ALUNO e por VISAO: um aluno pode estar certo numa visao e
-- errado na outra. Nada e apagado de revisao_prime_aluno, que e recalculada
-- por cron todo fim de semana e nao tem dono.
create table if not exists public.revisao_prime_tratativa (
  aluno_id    uuid not null,
  visao       text not null,
  status      text not null check (status in ('FEITO','REJEITADO')),
  motivo      text,
  por_email   text,
  em          timestamptz not null default now(),
  primary key (aluno_id, visao)
);

alter table public.revisao_prime_tratativa enable row level security;

drop policy if exists revisao_prime_tratativa_gestao_le on public.revisao_prime_tratativa;
create policy revisao_prime_tratativa_gestao_le
  on public.revisao_prime_tratativa for select
  using (public.usuario_e_gestao());

comment on table public.revisao_prime_tratativa is
  'O que ja foi olhado na Revisao Prime x CRM. FEITO = divergencia real tratada; REJEITADO = nao era divergencia, o caso esta certo no Prime.';

-- Escrita so pela RPC: assim o email de quem decidiu e a data entram sempre,
-- e ninguem grava um status fora do par FEITO/REJEITADO.
create or replace function public.revisao_prime_tratar(
  p_aluno_id uuid, p_visao text, p_status text, p_motivo text default null)
 returns jsonb
 language plpgsql security definer set search_path to 'public'
as $function$
declare v_email text;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: a Revisao Prime e restrita a gestao.' using errcode='42501';
  end if;
  if p_status is not null and p_status not in ('FEITO','REJEITADO') then
    raise exception 'Status invalido: use FEITO ou REJEITADO.';
  end if;

  v_email := lower(coalesce(auth.email(), 'desconhecido'));

  -- status nulo desfaz: a linha volta para a fila.
  if p_status is null then
    delete from public.revisao_prime_tratativa
     where aluno_id = p_aluno_id and visao = p_visao;
    return jsonb_build_object('acao','reaberto','aluno_id',p_aluno_id,'visao',p_visao);
  end if;

  insert into public.revisao_prime_tratativa (aluno_id, visao, status, motivo, por_email, em)
  values (p_aluno_id, p_visao, p_status, nullif(btrim(coalesce(p_motivo,'')),''), v_email, now())
  on conflict (aluno_id, visao) do update
     set status = excluded.status, motivo = excluded.motivo,
         por_email = excluded.por_email, em = now();

  return jsonb_build_object('acao','gravado','status',p_status,'por',v_email);
end;
$function$;

revoke all on function public.revisao_prime_tratar(uuid, text, text, text) from public, anon;
grant execute on function public.revisao_prime_tratar(uuid, text, text, text) to authenticated;
