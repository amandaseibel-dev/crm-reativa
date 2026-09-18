-- CONFERENCIA PRIME -- decisao posterior da gestao que substitui a pendencia CONFIRMACAO_PRIME_QUITACAO_TOTAL_AGUARDA_REGRA_GESTAO.
-- So registra. O registro anterior fica como historico, intacto.
do $d$
declare v_ant record;
begin
  select id, created_at, detalhes into v_ant from public.auditoria
   where acao = 'CONFIRMACAO_PRIME_QUITACAO_TOTAL_AGUARDA_REGRA_GESTAO' order by created_at desc limit 1;
  if v_ant.id is null then
    raise exception 'DECISAO: registro anterior nao encontrado';
  end if;
  if exists (select 1 from public.auditoria where acao = 'CONFIRMACAO_PRIME_QUITACAO_TOTAL_AUTORIZADA') then
    raise exception 'DECISAO: ja registrada';
  end if;
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'CONFIRMACAO_PRIME_QUITACAO_TOTAL_AUTORIZADA', 'prime_conferencia_decisao', v_ant.id,
          jsonb_build_object(
            'substitui', 'CONFIRMACAO_PRIME_QUITACAO_TOTAL_AGUARDA_REGRA_GESTAO',
            'registro_anterior_id', v_ant.id, 'registro_anterior_em', v_ant.created_at,
            'decisao', 'gestao 18/09/2026: se a confirmacao Prime quitar a ultima divida exigivel do aluno, o aluno fica QUITADO, o caso e encerrado, responsavel e operador podem ser liberados, a vaga e liberada e o registro normal de reposicao pode ser criado',
            'reposicao_automatica', 'continua PAUSADA: liberar vaga sim, redistribuir aluno novo agora nao',
            'universo', jsonb_build_object('titulos', v_ant.detalhes->'titulos', 'alunos', v_ant.detalhes->'alunos', 'valor', v_ant.detalhes->'valor')));
end;
$d$;
