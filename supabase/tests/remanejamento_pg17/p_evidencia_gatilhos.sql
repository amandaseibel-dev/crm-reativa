-- EVIDENCIA dos gatilhos de alunos, casos e acordos (B3).
-- A lista ESPERADA sao os gatilhos de producao de 18/11 (estruturas_prod.json), com a decisao da
-- triagem (triagem_gatilhos.json). A comparacao e ELEMENTO A ELEMENTO com pg_trigger do CI:
--   (1) cada gatilho esperado: esta carregado, OU foi EXCLUIDO com justificativa;
--   (2) cada INCLUIR esperado tem que estar carregado;
--   (3) gatilho carregado que nao esta na lista de producao e falha.
-- Conta avaliados e aprovados e exige avaliados = total da lista (nao pode ser vazio).
-- Contagem de execucao NAO e prova de ausencia e nao entra na decisao.
\i lib.sql
select pg_temp.como('amanda.seibel@aelbra.com.br');

create temp table esperado (tabela text, gatilho text, decisao text, justificativa text) on commit preserve rows;
insert into esperado values
('acordos', 'trg_acordo_alerta_resolve_acordo', 'EXCLUIR', 'UPDATE OF status. O remanejamento grava em acordos apenas operador_responsavel_email e atualizado_em (set_resp_acordo); status nao e escrito no caminho, logo o gatilho nao dispara (filtro de coluna do PostgreSQL).'),
('acordos', 'trg_acordo_bloquear_duplicado', 'EXCLUIR', 'corpo: levanta excecao so com outro acordo ativo do mesmo aluno; os testes criam um acordo por aluno.'),
('acordos', 'trg_acordo_herda_responsavel', 'SEM_CLASSE', ''),
('acordos', 'trg_acordo_status_reavalia_titulos', 'EXCLUIR', 'UPDATE OF status (filtro de coluna): o remanejamento nao escreve status de acordo. Corpo: chama titulo_reavaliar (saldo), so relevante quando o status muda.'),
('acordos', 'trg_aluno_segue_dono_do_acordo', 'SEM_CLASSE', ''),
('acordos', 'trg_atribuir_responsavel_por_acordo', 'SEM_CLASSE', ''),
('acordos', 'trg_audit', 'EXCLUIR', 'corpo: fn_audit_generic, insere so em audit_log.'),
('acordos', 'trg_efetividade_invalidar_acordos', 'EXCLUIR', 'corpo: chama carteira_efetividade_invalidar, que insere so em carteira_efetividade_invalidacao. Nao altera responsavel, protecao, capacidade, elegibilidade nem rollback.'),
('acordos', 'trg_fila_acordo_fecha_ao_encerrar', 'EXCLUIR', 'UPDATE OF status (filtro de coluna); caminho nao escreve status.'),
('acordos', 'trg_guard_resp_acordo', 'SEM_CLASSE', ''),
('acordos', 'trg_recalc_acordo', 'INCLUIR', 'AFTER INSERT OR UPDATE sem filtro; chama recalcular_situacao_aluno, que escreve alunos.data_retorno/retorno_origem. Carregado; teste de retorno preservado passou no CI em 2b36afa4.'),
('acordos', 'trg_titulo_quita_com_o_acordo', 'EXCLUIR', 'UPDATE OF status (filtro de coluna); caminho nao escreve status.'),
('acordos', 'trg_titulos_por_status_acordo', 'EXCLUIR', 'UPDATE OF status (filtro de coluna); corpo atua so quando status=QUITADO; caminho nao escreve status.'),
('alunos', 'trg_acionamento_nao_volta_para_nulo', 'SEM_CLASSE', ''),
('alunos', 'trg_aluno_concluir_retorno_adm_link', 'EXCLUIR', 'UPDATE OF status_atual.'),
('alunos', 'trg_aluno_encerramento_propaga', 'EXCLUIR', 'UPDATE OF status_atual.'),
('alunos', 'trg_aluno_estado_anterior', 'EXCLUIR', 'corpo: insere so em alunos_estado_anterior.'),
('alunos', 'trg_aluno_reset_retorno_confirmado', 'SEM_CLASSE', ''),
('alunos', 'trg_alunos_retorno_origem', 'SEM_CLASSE', ''),
('alunos', 'trg_atualizar_nome_normalizado', 'EXCLUIR', 'UPDATE OF nome.'),
('alunos', 'trg_audit_del', 'EXCLUIR', 'corpo: fn_audit_generic, insere so em audit_log; so em DELETE.'),
('alunos', 'trg_audit_responsavel_aluno', 'EXCLUIR', 'corpo: insere so em audit_log (TROCA_RESPONSAVEL); nao altera responsavel.'),
('alunos', 'trg_encerramento_so_gestao', 'INCLUIR', 'dispara em UPDATE OF status_acionamento, que set_resp_aluno zera na troca de responsavel do caminho oficial; valida transicao de encerramento (elegibilidade). Pendente: carregar _encerramento_so_gestao e dependencias.'),
('alunos', 'trg_fechar_confirmacao_ao_quitar', 'EXCLUIR', 'UPDATE OF status_atual,status_jornada.'),
('alunos', 'trg_guard_resp_aluno', 'SEM_CLASSE', ''),
('alunos', 'trg_nome_do_operador_no_aluno', 'SEM_CLASSE', ''),
('alunos', 'trg_sincronizar_alunos_unificados', 'EXCLUIR', 'corpo: escreve so em alunos_unificados (operador/responsavel espelhados); nao altera alunos.responsavel nem casos.'),
('alunos', 'trg_sync_acionamento_alunos_para_casos', 'INCLUIR', 'grava casos.data_ultimo_acionamento a partir de alunos (relogio da fidelizacao de 10 dias). Pendente: carregar fn_sync_acionamento_alunos_para_casos.'),
('alunos', 'trg_sync_casos_resp_aluno', 'SEM_CLASSE', ''),
('alunos', 'trg_tabulacao_efeito_financeiro', 'EXCLUIR', 'UPDATE OF status_jornada.'),
('alunos', 'trg_tabulacao_redireciona', 'EXCLUIR', 'UPDATE OF status_jornada; os caminhos testados nao escrevem status_jornada.'),
('alunos', 'trg_tabulacao_so_gestao_insert', 'EXCLUIR', 'BEFORE INSERT em alunos; os caminhos testados nao inserem alunos em tabulacao (semeadura de teste: fora do caminho de producao).'),
('casos', 'trg_audit_del', 'EXCLUIR', 'corpo: fn_audit_generic; so em DELETE.'),
('casos', 'trg_auditar_encerramento_operacional', 'EXCLUIR', 'corpo: insere so em casos_encerramento_auditoria.'),
('casos', 'trg_auditar_nao_acionar', 'EXCLUIR', 'UPDATE OF nao_acionar (filtro) e grava so auditoria.'),
('casos', 'trg_bloquear_alteracoes_restritas_casos', 'EXCLUIR', 'corpo: levanta excecao so se mudam status_financeiro, quitado_em, valor_quitado, valor_cobranca_ajustado e campos de ajuste; o caminho do remanejamento nao escreve essas colunas.'),
('casos', 'trg_casos_set_encerrado_operacional', 'INCLUIR', 'sem filtro de coluna; define encerrado_operacional, que exclui o caso da elegibilidade do remanejamento. Pendente: carregar casos_set_encerrado_operacional.'),
('casos', 'trg_fechar_confirmacao_ao_quitar_caso', 'EXCLUIR', 'UPDATE OF status_atual,quitado_em,origem_quitacao; os caminhos nao escrevem essas colunas.'),
('casos', 'trg_giro_limpar_marca', 'SEM_CLASSE', ''),
('casos', 'trg_nome_do_operador_no_caso', 'SEM_CLASSE', ''),
('casos', 'trg_sync_alunos_apos_casos', 'SEM_CLASSE', ''),
('casos', 'trg_zz_caso_nao_duplica_aluno', 'EXCLUIR', 'corpo: levanta excecao so com dois casos abertos para o mesmo aluno; o indice unico ux_casos_uma_ficha_aberta_por_aluno (carregado) ja impede isso; os testes criam um caso aberto por aluno.'),
('casos', 'trg_zz_caso_nao_duplica_aluno_before', 'EXCLUIR', 'idem trg_zz_caso_nao_duplica_aluno (mesma funcao de guarda).'),
('casos', 'trigger_impor_teto_operador', 'SEM_CLASSE', ''),
('casos', 'trigger_repor_caso_operador', 'INCLUIR', 'libera o caso (operador_email=null) e grava reposicao_carteira_fila quando a protecao muda; afeta capacidade e fidelizacao. Pendente: carregar com dependencias reais (tipo_fechamento_caso, historico_operadores_alunos, reposicao_carteira_fila).');

create temp table carregado on commit preserve rows as
  select c.relname::text as tabela, t.tgname::text as gatilho
    from pg_trigger t join pg_class c on c.oid = t.tgrelid
    join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
   where not t.tgisinternal and c.relname in ('alunos','casos','acordos');

do $$
declare ex record; cl record; n_total int; n_av int := 0; n_ok int := 0; n_fal int := 0; n_extra int := 0;
begin
  select count(*) into n_total from esperado;
  for ex in select * from esperado loop
    n_av := n_av + 1;
    if exists (select 1 from carregado k where k.tabela = ex.tabela and k.gatilho = ex.gatilho) then
      n_ok := n_ok + 1;
    elsif ex.decisao = 'INCLUIR' then
      n_fal := n_fal + 1; raise notice 'FALHA: % (%) e INCLUIR e nao esta carregado', ex.gatilho, ex.tabela;
    elsif ex.decisao = 'EXCLUIR' and coalesce(ex.justificativa, '') <> '' then
      n_ok := n_ok + 1;
    else
      n_fal := n_fal + 1; raise notice 'FALHA: % (%) sem classificacao valida (%)', ex.gatilho, ex.tabela, ex.decisao;
    end if;
  end loop;
  for cl in select * from carregado k where not exists (
        select 1 from esperado x where x.tabela = k.tabela and x.gatilho = k.gatilho) loop
    n_extra := n_extra + 1; raise notice 'FALHA: % (%) carregado mas ausente da lista de producao', cl.gatilho, cl.tabela;
  end loop;
  raise notice 'gatilhos: %/% avaliados, % aprovados, % falhas, % extras', n_av, n_total, n_ok, n_fal, n_extra;
  perform pg_temp.afirma(n_total = 45 and n_av = n_total and n_fal = 0 and n_extra = 0,
    format('gatilhos: %s avaliados, %s aprovados, %s falhas, %s extras', n_av, n_ok, n_fal, n_extra));
end $$;
select 'EVIDENCIA OK' as resultado;
