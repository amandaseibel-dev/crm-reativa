-- ROLLBACK de 20261019093000_acao_massiva_tabula_com_retorno_10_dias.
--
-- Desfaz a tabulacao da acao massiva: a massiva volta a registrar o
-- acionamento SEM gravar status_acionamento e SEM agendar retorno, que e o
-- estado de 03/10/2026 (migration 20261003083400).
--
-- NAO desfaz dado: alunos e casos que JA foram tabulados ficam como estao --
-- apagar status e retorno de quem foi acionado seria inventar um fato novo, e
-- a regra da casa e que acionamento registrado nao se apaga
-- (_acionamento_nao_volta_para_nulo). Reverter dados, se for o caso, e decisao
-- separada, com backup por id.
--
-- E o patch EXATAMENTE reverso do da migration: cada bloco novo volta a ser a
-- ancora que ele substituiu, e o md5 do corpo restaurado e CONFERIDO contra o
-- que estava vivo em producao em 19/10/2026. Se nao bater, falha alto em vez de
-- deixar uma terceira versao no banco.

-- ------------------------------------------- registrar_acao_massiva
do $rb$
declare
  v_def text;
  v_novo text;
  v_md5 text;
begin
  v_def := pg_get_functiondef('public.registrar_acao_massiva(text[],text,text,text,text,text,uuid,jsonb)'::regprocedure);
  v_novo := v_def;
  if position($a$  v_mot text;
  v_tab int := 0;
begin$a$ in v_novo) = 0 then
    raise exception 'Bloco da tabulacao nao esta presente em registrar_acao_massiva: nada a desfazer.' using errcode = '55000';
  end if;
  v_novo := replace(v_novo, $a$  v_mot text;
  v_tab int := 0;
begin$a$, $a$  v_mot text;
begin$a$);
  if position($a$  -- TABULACAO DA ACAO MASSIVA (gestao, 19/10/2026): "coloque 10 dias, ja esta
  -- padronizado nessa forma". Mesma forma de sempre -- status com o prefixo
  -- 'Ação massiva' e retorno +10 dias CORRIDOS -- que e exatamente a regra que
  -- recalcular_situacao_aluno aplica (prefixo + (hoje - dua) < 10 => dua + 10).
  -- Escrito aqui, e nao reabrindo a recalculadora no gatilho (ver 20261003083400):
  -- ela tambem reescreve situacao, criticidade e proxima acao, e e compartilhada.
  -- NAO toca status_jornada/status_atual: trg_tabulacao_efeito_financeiro e
  -- trg_tabulacao_redireciona so disparam quando status_jornada muda, e acao
  -- massiva nao pode gerar efeito financeiro nem encaminhamento.
  if coalesce(array_length(v_registrados, 1), 0) > 0 then
    update public.alunos a
       set status_acionamento = 'Ação massiva externa enviada — aguardando retorno',
           data_retorno = case
             when a.data_retorno > current_date
                  and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%'
             then a.data_retorno
             else current_date + 10 end,
           retorno_origem = case
             when a.data_retorno > current_date
                  and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%'
             then a.retorno_origem
             else 'AUTOMATICO' end
     where a.id = any(v_registrados::uuid[]);
    get diagnostics v_tab = row_count;

    -- O caso acompanha o aluno: fn_sync_acionamento_alunos_para_casos
    -- sincroniza SO data_ultimo_acionamento. casos nao tem retorno_origem,
    -- entao espelha a data que ficou no aluno (igual a recalculadora faz).
    update public.casos c
       set data_retorno = a.data_retorno
      from public.alunos a
     where a.id = c.aluno_id
       and c.aluno_id = any(v_registrados::uuid[])
       and c.data_retorno is distinct from a.data_retorno;
  end if;

  v_contatos := coalesce(($a$ in v_novo) = 0 then
    raise exception 'Bloco da tabulacao nao esta presente em registrar_acao_massiva: nada a desfazer.' using errcode = '55000';
  end if;
  v_novo := replace(v_novo, $a$  -- TABULACAO DA ACAO MASSIVA (gestao, 19/10/2026): "coloque 10 dias, ja esta
  -- padronizado nessa forma". Mesma forma de sempre -- status com o prefixo
  -- 'Ação massiva' e retorno +10 dias CORRIDOS -- que e exatamente a regra que
  -- recalcular_situacao_aluno aplica (prefixo + (hoje - dua) < 10 => dua + 10).
  -- Escrito aqui, e nao reabrindo a recalculadora no gatilho (ver 20261003083400):
  -- ela tambem reescreve situacao, criticidade e proxima acao, e e compartilhada.
  -- NAO toca status_jornada/status_atual: trg_tabulacao_efeito_financeiro e
  -- trg_tabulacao_redireciona so disparam quando status_jornada muda, e acao
  -- massiva nao pode gerar efeito financeiro nem encaminhamento.
  if coalesce(array_length(v_registrados, 1), 0) > 0 then
    update public.alunos a
       set status_acionamento = 'Ação massiva externa enviada — aguardando retorno',
           data_retorno = case
             when a.data_retorno > current_date
                  and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%'
             then a.data_retorno
             else current_date + 10 end,
           retorno_origem = case
             when a.data_retorno > current_date
                  and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%'
             then a.retorno_origem
             else 'AUTOMATICO' end
     where a.id = any(v_registrados::uuid[]);
    get diagnostics v_tab = row_count;

    -- O caso acompanha o aluno: fn_sync_acionamento_alunos_para_casos
    -- sincroniza SO data_ultimo_acionamento. casos nao tem retorno_origem,
    -- entao espelha a data que ficou no aluno (igual a recalculadora faz).
    update public.casos c
       set data_retorno = a.data_retorno
      from public.alunos a
     where a.id = c.aluno_id
       and c.aluno_id = any(v_registrados::uuid[])
       and c.data_retorno is distinct from a.data_retorno;
  end if;

  v_contatos := coalesce(($a$, $a$  v_contatos := coalesce(($a$);
  if position($a$    'ja_registrados', v_ja,
    'tabulados', v_tab,$a$ in v_novo) = 0 then
    raise exception 'Bloco da tabulacao nao esta presente em registrar_acao_massiva: nada a desfazer.' using errcode = '55000';
  end if;
  v_novo := replace(v_novo, $a$    'ja_registrados', v_ja,
    'tabulados', v_tab,$a$, $a$    'ja_registrados', v_ja,$a$);
  execute v_novo;
  select md5(prosrc) into v_md5 from pg_proc where oid = 'public.registrar_acao_massiva(text[],text,text,text,text,text,uuid,jsonb)'::regprocedure;
  if v_md5 is distinct from '7de4ee7830af47a4acec47d18a824e29' then
    raise exception 'Rollback de registrar_acao_massiva nao restaurou o corpo original (md5 %).', v_md5 using errcode = '55000';
  end if;
end;
$rb$;
-- ------------------------------- acoes_massivas_exportar_emails_do_lote
do $rb$
declare
  v_def text;
  v_novo text;
  v_md5 text;
begin
  v_def := pg_get_functiondef('public.acoes_massivas_exportar_emails_do_lote(uuid,text)'::regprocedure);
  v_novo := v_def;
  if position($a$  get diagnostics v_reg = row_count;

  -- TABULACAO (gestao, 19/10/2026): identica a de registrar_acao_massiva.
  -- v_ok sao os alunos com e-mail valido deste lote novo; o lote nasce agora,
  -- entao o on conflict acima nao descarta ninguem.
  if coalesce(array_length(v_ok, 1), 0) > 0 then
    update public.alunos a
       set status_acionamento = 'Ação massiva externa enviada — aguardando retorno',
           data_retorno = case
             when a.data_retorno > current_date
                  and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%'
             then a.data_retorno
             else current_date + 10 end,
           retorno_origem = case
             when a.data_retorno > current_date
                  and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%'
             then a.retorno_origem
             else 'AUTOMATICO' end
     where a.id = any(v_ok::uuid[]);

    update public.casos c
       set data_retorno = a.data_retorno
      from public.alunos a
     where a.id = c.aluno_id
       and c.aluno_id = any(v_ok::uuid[])
       and c.data_retorno is distinct from a.data_retorno;
  end if;$a$ in v_novo) = 0 then
    raise exception 'Bloco da tabulacao nao esta presente em acoes_massivas_exportar_emails_do_lote: nada a desfazer.' using errcode = '55000';
  end if;
  v_novo := replace(v_novo, $a$  get diagnostics v_reg = row_count;

  -- TABULACAO (gestao, 19/10/2026): identica a de registrar_acao_massiva.
  -- v_ok sao os alunos com e-mail valido deste lote novo; o lote nasce agora,
  -- entao o on conflict acima nao descarta ninguem.
  if coalesce(array_length(v_ok, 1), 0) > 0 then
    update public.alunos a
       set status_acionamento = 'Ação massiva externa enviada — aguardando retorno',
           data_retorno = case
             when a.data_retorno > current_date
                  and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%'
             then a.data_retorno
             else current_date + 10 end,
           retorno_origem = case
             when a.data_retorno > current_date
                  and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%'
             then a.retorno_origem
             else 'AUTOMATICO' end
     where a.id = any(v_ok::uuid[]);

    update public.casos c
       set data_retorno = a.data_retorno
      from public.alunos a
     where a.id = c.aluno_id
       and c.aluno_id = any(v_ok::uuid[])
       and c.data_retorno is distinct from a.data_retorno;
  end if;$a$, $a$  get diagnostics v_reg = row_count;$a$);
  execute v_novo;
  select md5(prosrc) into v_md5 from pg_proc where oid = 'public.acoes_massivas_exportar_emails_do_lote(uuid,text)'::regprocedure;
  if v_md5 is distinct from 'd37ddd499e81cc5381762cd8c95f25aa' then
    raise exception 'Rollback de acoes_massivas_exportar_emails_do_lote nao restaurou o corpo original (md5 %).', v_md5 using errcode = '55000';
  end if;
end;
$rb$;
