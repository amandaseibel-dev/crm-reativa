-- ROLLBACK da triagem operacional (20260919120000). Devolve a fila ao texto da
-- regra de entrada (20260918230000), remove cron, funcoes e colunas. Nao toca
-- em titulo, decisao, aluno, caso ou financeiro.
begin;
do $$ begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'prime_conferencia_triagem_hora';
  end if;
end $$;
drop function if exists public.prime_conferencia_ficha(uuid);
drop function if exists public.prime_conferencia_painel();
drop function if exists public.prime_conferencia_classificar_humano(uuid, text, text);
drop function if exists public.prime_conferencia_triagem_recalcular(uuid[]);
drop function if exists public.prime_conferencia_fila();
create function public.prime_conferencia_fila()
 returns table(titulo_id uuid, aluno_id uuid, aluno_nome text, cpf text, documento text, vencimento date, valor numeric,
               liquidado_em date, portador integer, corroboracao text, subgrupo text, acordo_id uuid, acordo_numero text,
               acordo_status text, razao numeric, revisao_obrigatoria boolean, operador_responsavel text,
               outras_dividas boolean, detectado_em timestamp with time zone, evidencia jsonb,
               classificacao text, motivo_entrada text)
 language plpgsql
 stable security definer
 set search_path to 'public'
as $function$
begin
  if not coalesce(public.usuario_e_gestao(), false) and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Conferencia Prime e decisao da gestao.' using errcode = '42501';
  end if;
  return query
  select d.titulo_id, d.aluno_id, al.nome, d.cpf, d.documento, t.vencimento, d.valor,
         coalesce((d.evidencia->>'liquidado_em')::date, (d.evidencia->'prime'->>'liquidado_em')::date),
         coalesce((d.evidencia->>'portador')::int, (d.evidencia->'prime'->>'portador')::int),
         d.corroboracao, d.subgrupo, d.acordo_id, d.acordo_numero, ac.status,
         (d.evidencia->>'razao_acordo_lote')::numeric, d.revisao_obrigatoria,
         al.responsavel_atual_email,
         not public.caso_aguarda_confirmacao_financeira(d.aluno_id),
         d.detectado_em, d.evidencia,
         coalesce(d.evidencia->>'classificacao',
                  case when d.subgrupo like 'A%' then 'GRUPO_A_HISTORICO' end),
         d.motivo_entrada
    from public.prime_conferencia_decisao d
    join public.acordos_titulos t on t.id = d.titulo_id
    left join public.alunos al on al.id = d.aluno_id
    left join public.acordos ac on ac.id = d.acordo_id
   where d.decisao = 'PENDENTE'
   order by (coalesce(d.subgrupo,'') in ('A_PAGAMENTO_COMPROVADO','B_ACORDO_COMPROVADO')) desc,
            (coalesce(d.subgrupo,'') like 'A2%') desc, d.valor desc, d.titulo_id;
end;
$function$;
grant execute on function public.prime_conferencia_fila() to authenticated, service_role;
alter table public.prime_conferencia_decisao drop constraint if exists prime_conferencia_decisao_classe_humana_check;
alter table public.prime_conferencia_decisao
  drop column if exists triagem, drop column if exists triagem_em,
  drop column if exists classe_humana, drop column if exists classe_humana_obs,
  drop column if exists classe_humana_por, drop column if exists classe_humana_em;
commit;
