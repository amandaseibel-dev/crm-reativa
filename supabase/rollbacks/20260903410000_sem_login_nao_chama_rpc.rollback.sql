-- Desfaz 20260903410000_sem_login_nao_chama_rpc: devolve o estado de prod de
-- 03/09/2026 antes da correção.
--
-- Cuidado: voltar isto REABRE a chamada sem login nas 47 funções, deixa a view
-- consulta_financeira_por_aluno de novo como SECURITY DEFINER e destranca a
-- tabela _mapa_casca_20260902 para qualquer usuário logado.

do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as assinatura, p.proname
    from pg_proc p
    where p.pronamespace = 'public'::regnamespace
      and p.proname = any (array[
        '_acordo_fecha_com_a_ultima_parcela','_acordo_herda_responsavel_do_aluno','_aluno_segue_dono_do_acordo',
        '_caso_nao_duplica_aluno','_confirmacao_sem_valor_sai_da_fila','_encerramento_so_gestao',
        '_fechar_confirmacao_ao_zerar_saldo','_fila_acordo_fecha_ao_encerrar_acordo','_notificacoes_diretoria_nao_recebe',
        '_pagamento_baixa_pelo_documento','_pagamento_vincula_aluno_por_nome_unico','_pagamentos_baixar_lote',
        '_parcela_guarda_titulo_origem','_parcela_pago_em_automatico','_reabrir_aluno_com_divida_nova',
        '_titulo_quita_com_o_acordo','_trg_aluno_estado_anterior','_trg_desfazer_cartao_tabulacao',
        '_trg_desfazer_cartao_termo','_trg_notif_termo_gov','_trg_recalc_por_vinculo_novo',
        'acoes_massivas_borderos','aluno_contato_adicionar','aluno_contato_invalidar','aluno_contato_revalidar',
        'aluno_contato_tornar_principal','aluno_contatos_sincronizar','aluno_matricula_semestres',
        'alunos_propaga_encerramento_para_caso','calibragem_simular_ano_parelho','dias_uteis',
        'fn_sync_acionamento_alunos_para_casos','prime_cadastro_aplicar','quitar_e_encerrar_caso','sistema_sob_carga',
        'tg_acordo_bloquear_duplicado','tg_aluno_concluir_retorno_adm_link','tg_conf_pagamento_agenda',
        'tg_pagamento_nome_do_operador','whatsapp_cadencia_consumo','whatsapp_cadencia_indicadores',
        'whatsapp_cadencia_registrar_bloqueio','whatsapp_canais_listar','whatsapp_canal_cadencia_salvar',
        'whatsapp_conversas_listar','whatsapp_resumo','whatsapp_supervisao'])
  loop
    -- 45 tinham EXECUTE via PUBLIC; dias_uteis e sistema_sob_carga tinham grant direto a anon.
    if r.proname in ('dias_uteis', 'sistema_sob_carga') then
      execute format('grant execute on function %s to anon', r.assinatura);
    else
      execute format('grant execute on function %s to public', r.assinatura);
    end if;
  end loop;
end $$;

do $$
begin
  if to_regclass('public.consulta_financeira_por_aluno') is not null then
    execute 'alter view public.consulta_financeira_por_aluno set (security_invoker = false)';
  end if;
  if to_regclass('public._mapa_casca_20260902') is not null then
    execute 'alter table public._mapa_casca_20260902 disable row level security';
    execute 'grant all on public._mapa_casca_20260902 to authenticated';
  end if;
end $$;
