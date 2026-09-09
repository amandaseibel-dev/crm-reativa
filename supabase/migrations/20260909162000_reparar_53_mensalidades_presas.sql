-- Repara os 53 titulos que ficaram presos em acordos CANCELADOS antes do
-- gatilho novo existir. Nao inventa regra: chama titulo_reavaliar, a mesma
-- funcao que o gatilho usa daqui para frente.
-- Resultado medido: 53 de 53 voltaram, R$ 81.041,60 de volta na carteira, 33 alunos.
create table if not exists public._backup_titulo_preso_cancelado_20260909 as
select t.id, t.aluno_id, t.documento, t.situacao, t.status, t.acordo_id,
       t.valor_original, t.saldo_corrigido, now() as em
  from public.acordos_titulos t where false;

alter table public._backup_titulo_preso_cancelado_20260909 enable row level security;
drop policy if exists sem_acesso on public._backup_titulo_preso_cancelado_20260909;
create policy sem_acesso on public._backup_titulo_preso_cancelado_20260909 for select using (false);

insert into public._backup_titulo_preso_cancelado_20260909
  (id, aluno_id, documento, situacao, status, acordo_id, valor_original, saldo_corrigido, em)
select t.id, t.aluno_id, t.documento, t.situacao, t.status, t.acordo_id,
       t.valor_original, t.saldo_corrigido, now()
  from public.acordo_titulo_vinculo v
  join public.acordos a on a.id = v.acordo_id and upper(coalesce(a.status,'')) in ('CANCELADO','CANCELADA')
  join public.acordos_titulos t on t.id = v.titulo_id
 where t.status = 'vinculada' and upper(coalesce(t.situacao,'')) = 'NEGOCIADO';

do $$
declare v_titulo uuid;
begin
  for v_titulo in select id from public._backup_titulo_preso_cancelado_20260909 loop
    perform public.titulo_reavaliar(v_titulo);
  end loop;
end $$;

do $$
declare v_aluno uuid;
begin
  for v_aluno in select distinct aluno_id from public._backup_titulo_preso_cancelado_20260909
                  where aluno_id is not null loop
    perform public.recalcular_situacao_aluno(v_aluno);
  end loop;
end $$;

insert into public.invariante_config (nome, severidade, titulo, explicacao, base_09_09)
values ('mensalidade_presa_em_acordo_cancelado','GRAVE','Mensalidade presa em acordo cancelado',
  'O acordo foi cancelado, entao a divida volta -- mas a mensalidade continua marcada como negociada e ninguem a cobra. Eram 53 (R$ 81.041,60) em 09/09, a mais antiga desde 24/07.','53 · R$ 81.041,60 (reparadas em 09/09)')
on conflict (nome) do update
  set severidade = excluded.severidade, titulo = excluded.titulo, explicacao = excluded.explicacao;
