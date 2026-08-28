-- Caso quitado continuava na base quando os titulos eram zerados DEPOIS do status.
-- O gatilho casos_set_encerrado_operacional so recalcula quando um status muda; se a
-- baixa dos titulos veio depois, o caso ficava com encerrado_operacional = false para sempre.
-- O cron diario retirar_zerados_reais_sem_saldo nao pega esses: ele exclui quitado_em is not null.
-- Resultado: 186 casos ja quitados seguiam contando na carteira e nas filas.

create or replace function public.casos_reavaliar_encerramento(p_limite integer default null)
returns integer
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '180s'
as $$
declare v_n integer;
begin
  with alvo as (
    select c.id
      from public.casos c
     where not coalesce(c.encerrado_operacional, false)
       and c.aluno_id is not null
       -- a regra que ja existe diz que esta encerrado...
       and public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                                             c.status_financeiro, c.status_jornada)
       -- ...e o saldo canonico confirma que nao ha divida
       and (public.aluno_saldo_pendente_detalhe(c.aluno_id)->>'total')::numeric <= 0.005
     limit coalesce(p_limite, 100000)
  )
  update public.casos c
     set encerrado_operacional = true,
         caso_atualizado_por = 'sistema_reavaliar_encerramento',
         caso_atualizado_em = now()
    from alvo a
   where c.id = a.id;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

revoke all on function public.casos_reavaliar_encerramento(integer) from public, anon, authenticated;
grant execute on function public.casos_reavaliar_encerramento(integer) to service_role;

select cron.schedule('casos_reavaliar_encerramento_horario', '30 * * * *',
                     'select public.casos_reavaliar_encerramento();');
