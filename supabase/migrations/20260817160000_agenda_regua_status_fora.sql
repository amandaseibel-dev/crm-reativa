-- Agenda Operacional: retorno de RÉGUA POR STATUS não é agendamento.
--
-- PREMISSA (Amanda, 17/08/2026): a Agenda só mostra retorno agendado pelo
-- operador. "Mensagem enviada" e companhia NÃO entram -- o retorno delas é
-- gerado pela régua (retornoAutomaticoDeStatus no PainelCarteira: mensagem
-- enviada +2 dias úteis, link +1, comprovante +3, acordo fechado +2), não é
-- compromisso marcado com o aluno.
--
-- Daqui pra frente o frontend já grava 'AUTOMATICO' nesses casos. Isto aqui
-- é só o legado: o backfill de 20260817120000 marcou como 'OPERADOR' todo
-- retorno futuro de cobrança vencida sem prova de origem, e 115 desses eram
-- justamente régua de MENSAGEM_ENVIADA (de 170 marcados, 136 estavam nesse
-- status).
--
-- Preserva quem tem prova de agendamento manual: movimentação registrada
-- com data_retorno igual à da ficha significa que o operador digitou a data
-- ao tabular -- aí é compromisso, mesmo que o status seja de régua.

update public.alunos a
   set retorno_origem = 'AUTOMATICO'
 where a.retorno_origem = 'OPERADOR'
   and coalesce(a.status_atual, '') in (
     'MENSAGEM_ENVIADA','SOLICITADO_LINK','AGUARDANDO_LINK','LINK_PRONTO_PARA_ENVIO',
     'TERMO_ENVIADO_ALUNO','NAO_LOCALIZADO','AGUARDANDO_COMPROVANTE','ACORDO_FECHADO',
     'Novo caso','Em cobrança')
   and not exists (
     select 1 from public.aluno_movimentacoes m
      where m.aluno_id = a.id::text
        and m.data_retorno::date = a.data_retorno);
