-- Volta a regra de encerramento a ignorar `situacao_operacional = QUITADO`.
-- Atenção: casos quitados via acordo voltam a ficar abertos para sempre.
create or replace function public.casos_reavaliar_encerramento(p_limite integer default null::integer)
 returns integer language plpgsql security definer
 set search_path to 'public' set statement_timeout to '180s'
as $function$
declare v_n integer;
begin
  with alvo as (
    select c.id from public.casos c join public.alunos al on al.id = c.aluno_id
     where not coalesce(c.encerrado_operacional, false) and c.aluno_id is not null
       and (public.aluno_saldo_pendente_detalhe(c.aluno_id)->>'total')::numeric <= 0.005
       and (public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                                              c.status_financeiro, c.status_jornada)
            or upper(coalesce(al.status_atual,'')) ~ 'QUIT|BAIXA|SALDO_ZERO|SEM_SALDO')
     limit coalesce(p_limite, 100000))
  update public.casos c set encerrado_operacional = true,
         caso_atualizado_por = 'sistema_reavaliar_encerramento', caso_atualizado_em = now()
    from alvo a where c.id = a.id;
  get diagnostics v_n = row_count; return v_n;
end; $function$;
