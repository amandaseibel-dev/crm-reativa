-- =====================================================================
-- ROLLBACK DA ETAPA DE PROTECAO DE 12/09/2026. Preparado, NAO EXECUTADO.
-- Reverte a migration 20260912130752. Tres blocos independentes: execute
-- apenas o que quiser desfazer.
--
-- Nenhum deles toca dado financeiro. Nenhum deles recria ou desfaz vinculo.
-- =====================================================================

-- ---------------------------------------------------------------------
-- BLOCO 1. Religa a etapa 'vinculo_por_negociacao' do fluxo horario.
--
-- ANTES DE RELIGAR, entenda o que volta: prime_vincular_por_negociacao
-- escolhe o ACORDO por proximidade temporal (janela de 3 dias) e, havendo
-- dois ou mais acordos candidatos do mesmo aluno, decide pelo mais proximo
-- SEM sinalizar. Medido em 12/09/2026: 3 de 82 vinculos tinham 2 e 3
-- acordos possiveis. Religar sem antes existir identificador explicito do
-- acordo no espelho do Prime recria exatamente esse risco.
-- ---------------------------------------------------------------------
begin;
update public.fluxo_pagamentos_config
   set ligado = true,
       observacao = 'Infere pelo Prime qual divida o acordo substituiu (portador 195, tolerancia 3 dias).'
                 || ' Sem isto o acordo importado nao diz de onde veio.',
       alterado_em = now(),
       alterado_por = 'rollback_protecao_20260912'
 where etapa = 'vinculo_por_negociacao';

insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
values (coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'gestao'),
        'RELIGOU_ETAPA_FLUXO', 'fluxo_pagamentos_config', null,
        jsonb_build_object('etapa','vinculo_por_negociacao','ligado_depois',true,
                           'reverte_migration','20260912130752'));
commit;

-- ---------------------------------------------------------------------
-- BLOCO 2. Devolve EXECUTE de fluxo_pagamentos_rodar(text) a authenticated.
--
-- NAO RECOMENDADO. Isso devolve a qualquer usuario logado o poder de
-- disparar o fluxo financeiro inteiro -- baixa, vinculo e recalculo de
-- saldo -- porque a funcao seta `reativa.fluxo_pagamentos = on`, que e a
-- chave que abre o portao de todas as rotinas internas. Se a motivacao for
-- dar um botao "rodar agora" para a gestao, o caminho certo e outro: criar
-- uma RPC propria com portao `usuario_e_gestao()` que chame esta por
-- dentro, em vez de reabrir para todos.
-- ---------------------------------------------------------------------
-- grant execute on function public.fluxo_pagamentos_rodar(text) to authenticated;

-- ---------------------------------------------------------------------
-- BLOCO 3. Volta pagamentos_sem_aluno a assinatura de 1 argumento, sem
-- portao interno e sem motivo financeiro (estado anterior a 20260912131004).
--
-- Reverte tambem a integracao com fila_pagamento_sem_vinculo. A tela
-- PagamentosSemAluno.jsx passaria a chamar a RPC com um parametro que nao
-- existe mais -- so execute este bloco junto com o revert do frontend.
-- ---------------------------------------------------------------------
-- drop function if exists public.pagamentos_sem_aluno(text, boolean);
-- create or replace function public.pagamentos_sem_aluno(p_mes text default null)
-- returns table (pagamento_id uuid, data_pagamento date, aluno_nome text, matricula text,
--                titulo_numero text, numero_parcela_completo text, valor_pago numeric,
--                valor_honorario numeric, operador_nome text, operador_email text,
--                motivo text, candidatos integer)
-- language sql security definer set search_path to 'public' as $$
--   with mes as (select coalesce(p_mes, to_char(now() at time zone 'America/Sao_Paulo','YYYY-MM')) as m)
--   select p.id, p.data_pagamento, p.aluno_nome, p.matricula, p.titulo_numero,
--          p.numero_parcela_completo, p.valor_pago, p.valor_honorario,
--          p.operador_nome, p.operador_email,
--          case when c.qtd > 1 then 'NOME_REPETIDO' else 'SEM_CADASTRO' end,
--          coalesce(c.qtd,0)::int
--     from public.pagamentos p, mes
--     left join lateral (select count(*)::int as qtd from public.alunos a
--                         where upper(trim(a.nome)) = upper(trim(coalesce(p.aluno_nome,'')))) c on true
--    where p.aluno_id is null and to_char(p.data_pagamento,'YYYY-MM') = mes.m
--    order by p.valor_pago desc;
-- $$;
-- grant execute on function public.pagamentos_sem_aluno(text) to authenticated;

-- ---------------------------------------------------------------------
-- O que este arquivo NAO desfaz, de proposito:
--   * pagamentos.origem_vinculo / _ref / _em (20260912131102): so registra,
--     nao decide nada. Remover apagaria rastro sem ganho;
--   * o fechamento da linha da fila em pagamento_vincular_aluno: e historico
--     de decisao humana;
--   * os 82 vinculos EXATO_PRIME_195 de 12/09. Para aqueles, o caminho e
--     acordo_titulo_vinculo.ativo = false + restaurar acordos_titulos de
--     _backup_vinc_negociacao_20260912024025 / _034023 / _044025, decisao
--     que ainda nao foi tomada.
-- =====================================================================
