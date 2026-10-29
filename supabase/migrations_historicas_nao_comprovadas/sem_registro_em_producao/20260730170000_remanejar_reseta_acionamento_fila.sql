-- Remanejamento zera o acionamento para o novo operador (volta ao topo da fila)
--
-- Contexto: a Fila Operacional decide "aguardando acionamento" por
-- public.alunos.data_ultimo_acionamento IS NULL (FilaOperacional.jsx:491).
-- A RPC alterar_responsavel_aluno delega o UPDATE de alunos a
-- internal.set_resp_aluno, que troca o responsavel mas NAO reseta o estado de
-- acionamento. Resultado: o caso remanejado chega no novo operador carregando o
-- acionamento antigo e cai no meio da fila em vez de subir como caso novo.
--
-- Correcao: quando o responsavel muda de fato (v_ant_email IS DISTINCT FROM
-- v_email), zerar data_ultimo_acionamento / status_acionamento / proxima_acao /
-- data_retorno / hora_retorno na mesma transacao. Reatribuir para o MESMO
-- operador (no-op) nao mexe em nada.
--
-- Idempotente: CREATE OR REPLACE. Nao altera assinatura nem permissoes.

CREATE OR REPLACE FUNCTION internal.set_resp_aluno(p_aluno_id uuid, p_novo_email text, p_novo_nome text, p_tipo text, p_descricao text, p_autor_email text, p_autor_nome text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_ant_email text; v_ant_nome text; v_email text := case when p_novo_email is null then null else lower(p_novo_email) end;
begin
  select responsavel_atual_email, responsavel_atual_nome into v_ant_email, v_ant_nome from public.alunos where id=p_aluno_id;
  update public.alunos set
    responsavel_atual_email=v_email,
    responsavel_atual_nome=p_novo_nome,
    responsavel_atual_em=now(),
    -- Reset de acionamento SOMENTE em troca real de responsavel: caso volta a
    -- "aguardando acionamento" (topo da fila) para o novo operador fidelizar.
    data_ultimo_acionamento = case when v_ant_email is distinct from v_email then null else data_ultimo_acionamento end,
    status_acionamento      = case when v_ant_email is distinct from v_email then null else status_acionamento end,
    proxima_acao            = case when v_ant_email is distinct from v_email then null else proxima_acao end,
    data_retorno            = case when v_ant_email is distinct from v_email then null else data_retorno end,
    hora_retorno            = case when v_ant_email is distinct from v_email then null else hora_retorno end
  where id=p_aluno_id;
  insert into public.aluno_movimentacoes (aluno_id,tipo,descricao,operador_anterior_nome,operador_anterior_email,operador_novo_nome,operador_novo_email,registrado_por_nome,registrado_por_email,registrado_em)
  values (p_aluno_id::text, p_tipo, p_descricao, coalesce(v_ant_nome,'(sem)'), v_ant_email, p_novo_nome, v_email, coalesce(p_autor_nome,p_autor_email), p_autor_email, now());
end;$function$;
