-- FILA DE CASOS SEM RESPONSAVEL (11/09/2026)
--
-- Regra da gestao: "se nao tiver dono vai para fila sem responsavel".
--
-- Ate hoje so existia a fila de ACORDOS sem responsavel. Casos orfaos que devem
-- mensalidade nao apareciam em lugar nenhum: 95 casos, R$ 169.819,72, dos quais
-- 42 so tem mensalidade -- invisiveis para toda a operacao.
--
-- APLICADA EM PRODUCAO em 11/09/2026 pelo MCP. Este arquivo versiona o estado
-- final; o conteudo e identico ao aplicado.

CREATE OR REPLACE FUNCTION public.fila_casos_sem_responsavel()
 RETURNS TABLE(
   caso_id uuid, aluno_id uuid, aluno text, cpf text, matricula text,
   mensalidade numeric, acordo numeric, total numeric,
   status_acionamento text, data_ultimo_acionamento date,
   tem_acordo_ativo boolean, semestre_divida text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.id, c.aluno_id,
         coalesce(c.nome, c.nome_aluno, al.nome),
         c.cpf, c.matricula,
         round(coalesce(c.mensalidades_em_aberto,0), 2),
         round(coalesce(c.acordo_em_aberto,0), 2),
         round(coalesce(c.mensalidades_em_aberto,0) + coalesce(c.acordo_em_aberto,0), 2),
         c.status_acionamento,
         c.data_ultimo_acionamento::date,
         exists (select 1 from public.acordos a
                  where a.cpf = lpad(regexp_replace(coalesce(c.cpf_limpo,''), '\D','','g'), 11, '0')
                    and a.status = 'ATIVO'),
         al.semestre_divida
    from public.casos c
    join public.alunos al on al.id = c.aluno_id
   where c.operador_email is null
     and al.responsavel_atual_email is null
     and coalesce(c.mensalidades_em_aberto,0) + coalesce(c.acordo_em_aberto,0) > 0
     and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual,
           c.status_acionamento, c.status_financeiro, c.status_jornada)
   order by coalesce(c.mensalidades_em_aberto,0) + coalesce(c.acordo_em_aberto,0) desc;
$function$;

REVOKE ALL ON FUNCTION public.fila_casos_sem_responsavel() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fila_casos_sem_responsavel() TO authenticated;

-- Vincular usa internal.set_resp_aluno: pertence ao papel
-- reativa_responsavel_executor, entao passa pelo guard _guard_resp_aluno sem
-- marca de transacao, escreve no lado autoritativo (`alunos`) e deixa o gatilho
-- _sync_casos_resp_aluno espelhar para `casos`.
CREATE OR REPLACE FUNCTION public.vincular_responsavel_caso(
  p_aluno_ids uuid[],
  p_email text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_quem text := lower(coalesce(auth.email(), ''));
  v_nome text;
  v_id   uuid;
  v_qtd  int := 0;
begin
  if v_quem not in ('amanda.seibel@aelbra.com.br', 'cobranca04@aelbra.com.br') then
    raise exception 'So a Amanda e a Fernanda podem definir o responsavel de um caso.'
      using errcode = '42501';
  end if;

  if p_aluno_ids is null or array_length(p_aluno_ids, 1) is null then
    raise exception 'Nenhum caso selecionado.';
  end if;

  select nome into v_nome from public.usuarios where email = lower(p_email) and ativo;
  if v_nome is null then
    raise exception 'Operador % nao encontrado ou inativo.', p_email;
  end if;

  foreach v_id in array p_aluno_ids loop
    if exists (select 1 from public.alunos
                where id = v_id and responsavel_atual_email is null) then
      perform internal.set_resp_aluno(
        v_id, lower(p_email), v_nome,
        'ALTERACAO_OPERADOR',
        'Caso sem responsavel: dono definido pela fila de casos sem responsavel.',
        v_quem, v_quem);
      v_qtd := v_qtd + 1;
    end if;
  end loop;

  return jsonb_build_object('vinculados', v_qtd,
    'operador_email', lower(p_email), 'operador_nome', v_nome);
end;
$function$;

REVOKE ALL ON FUNCTION public.vincular_responsavel_caso(uuid[], text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.vincular_responsavel_caso(uuid[], text) TO authenticated;
