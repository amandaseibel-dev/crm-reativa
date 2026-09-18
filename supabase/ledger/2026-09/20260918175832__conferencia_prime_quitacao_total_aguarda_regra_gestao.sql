-- CONFERENCIA PRIME -- registro da decisao separada: L1 de alunos que ficariam totalmente quitados.
-- Autorizado pela gestao em 18/09/2026 (opcao 1). So registra: nenhum titulo, decisao, caso ou aluno e alterado.
-- Os titulos seguem EM_CONFIRMACAO / PENDENTE ate a gestao decidir a regra (A: quitacao padrao; B: preservar responsavel/caso).
do $q$
declare v_n int; v_alunos int; v_valor numeric;
begin
  create temp table _q on commit drop as
    select d.titulo_id, d.aluno_id, d.valor
      from public.prime_conferencia_decisao d join public.alunos a on a.id = d.aluno_id join public.acordos_titulos t on t.id = d.titulo_id
     where d.decisao = 'PENDENTE' and d.subgrupo = 'A1' and not d.revisao_obrigatoria
       and coalesce(a.situacao_operacional,'') = 'AGUARDANDO_CONFIRMACAO'
       and not (coalesce(upper(a.status_jornada),'') in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA')
             or coalesce(upper(a.status_atual),'') in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA')
             or coalesce(upper(a.status_acionamento),'') in ('JURIDICO','SUSPENSAO_COBRANCA','CANCELAMENTO_COBRANCA','COBRANCA CANCELADA'))
       and not exists (select 1 from public.solicitacoes_confirmacao_pagamento s where s.aluno_id = d.aluno_id::text and s.status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO'))
       and not exists (select 1 from public.fila_pagamento_sem_vinculo fp left join public.pagamentos pg on pg.id = fp.pagamento_id where fp.decisao is null and (pg.aluno_id = d.aluno_id or fp.aluno_escolhido_id = d.aluno_id))
       and t.documento not in ('3769303','3769305','4521350','4049973','4230290','1109937','1109938','3943353','3943354','3943355')
       and t.situacao = 'EM_CONFIRMACAO';
  select count(*), count(distinct aluno_id), round(sum(valor), 2) into v_n, v_alunos, v_valor from _q;
  if v_n <> 312 or v_alunos <> 205 or v_valor <> 857511.79 then
    raise exception 'QUITACAO_TOTAL: grupo mudou (% titulos, % alunos, R$ %)', v_n, v_alunos, v_valor;
  end if;
  insert into public.auditoria (usuario, acao, tabela_afetada, detalhes)
  values ('amanda.seibel@aelbra.com.br', 'CONFIRMACAO_PRIME_QUITACAO_TOTAL_AGUARDA_REGRA_GESTAO', 'prime_conferencia_decisao',
          jsonb_build_object(
            'titulos', v_n, 'alunos', v_alunos, 'valor', v_valor,
            'estado', 'EM_CONFIRMACAO / PENDENTE -- nao executar ate decisao da gestao',
            'motivo', 'confirmar zera a divida do aluno e a quitacao automatica atual apaga o responsavel, encerra o caso com operador NULL e enfileira reposicao QUITADO (medido a seco em 18/09)',
            'opcoes', jsonb_build_array('A: seguir a quitacao padrao e liberar responsavel/caso', 'B: preservar responsavel/caso por regra especifica da Conferencia Prime'),
            'restricao', 'nao alterar funcao ou trigger para contornar o comportamento atual',
            'titulo_ids', (select jsonb_agg(titulo_id order by aluno_id, titulo_id) from _q)));
end;
$q$;
