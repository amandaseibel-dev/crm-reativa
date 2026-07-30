-- Rollback: restaura internal.set_resp_aluno SEM o reset de acionamento.
-- Executar sob o papel dono: set role reativa_responsavel_executor; ... reset role;

CREATE OR REPLACE FUNCTION internal.set_resp_aluno(p_aluno_id uuid, p_novo_email text, p_novo_nome text, p_tipo text, p_descricao text, p_autor_email text, p_autor_nome text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_ant_email text; v_ant_nome text; v_email text := case when p_novo_email is null then null else lower(p_novo_email) end;
begin
  select responsavel_atual_email, responsavel_atual_nome into v_ant_email, v_ant_nome from public.alunos where id=p_aluno_id;
  update public.alunos set responsavel_atual_email=v_email, responsavel_atual_nome=p_novo_nome, responsavel_atual_em=now() where id=p_aluno_id;
  insert into public.aluno_movimentacoes (aluno_id,tipo,descricao,operador_anterior_nome,operador_anterior_email,operador_novo_nome,operador_novo_email,registrado_por_nome,registrado_por_email,registrado_em)
  values (p_aluno_id::text, p_tipo, p_descricao, coalesce(v_ant_nome,'(sem)'), v_ant_email, p_novo_nome, v_email, coalesce(p_autor_nome,p_autor_email), p_autor_email, now());
end;$function$;
