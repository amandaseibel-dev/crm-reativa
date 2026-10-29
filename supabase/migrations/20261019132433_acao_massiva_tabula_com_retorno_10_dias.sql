-- ACAO MASSIVA VOLTA A TABULAR, NA FORMA JA PADRONIZADA (RETORNO +10 DIAS).
--
-- PEDIDO DA GESTAO (Amanda, 19/10/2026): "coloque 10 dias, ja esta
-- padronizado nessa forma". Decisao tomada depois da medicao abaixo.
--
-- O QUE FOI MEDIDO EM PRODUCAO EM 19/10/2026 (antes desta migration):
--   * lote d2f6bdd4-de9a-4ab0-babc-aec509c7c2b8 (19/10 08:59, WhatsApp,
--     MENSALIDADES, 300 alunos): 300 movimentacoes ACAO_MASSIVA_EXTERNA,
--     300/300 alunos e 302/302 casos com data_ultimo_acionamento = hoje,
--     e ZERO tabulacao (status_novo nulo em 300 de 300);
--   * outubro inteiro, por origem: massiva WhatsApp 8.296 linhas / 0 tabulada,
--     massiva e-mail do lote 4.888 / 0 tabulada, e-mail INDIVIDUAL do operador
--     3.171 / 3.171 tabuladas (100%). Mesmo tipo de movimentacao; o que separa
--     e a origem;
--   * ago/set/out: 25.923 massivas de WhatsApp, zero tabulacao em todos os meses.
--
-- QUAL E A "FORMA JA PADRONIZADA". Nao e invencao desta migration:
--   * 6.294 alunos ja carregam status_acionamento = 'Ação massiva externa
--     enviada — aguardando retorno' (valor UNICO na base, 49 chars,
--     md5 dda8af31f097061065008a4f34434565);
--   * recalcular_situacao_aluno TEM a regra viva, por PREFIXO:
--       coalesce(status_acionamento,'') ilike 'Ação massiva%'  -> v_acao_massiva
--       ...
--       elsif v_acao_massiva and v_ult_acion is not null
--             and (hoje - v_ult_acion) < 10 then
--          v_retorno := v_ult_acion + 10;
--          v_origem  := 'AUTOMATICO';
--     isto e: +10 dias CORRIDOS contados do ultimo acionamento, nao dias uteis.
--   * registrar_acao_massiva ANTES de 16/09 gravava exatamente isso
--     (20260805290000: v_retorno date := (current_date + 10)).
--
-- POR QUE O +10 NAO CHEGAVA SOZINHO. fn_atualizar_ultimo_acionamento PULA a
-- recalculadora justamente para ACAO_MASSIVA_EXTERNA / _EMAIL (migration
-- 20261003083400). Prova: dos 300 alunos do lote de hoje, 299 JA tem o status
-- 'Ação massiva%' (de massivas antigas) e mesmo assim estao com data_retorno =
-- hoje, nao hoje+10. Logo o status sozinho nao basta: o retorno tem de ser
-- escrito no registro.
--
-- POR QUE NAO REABRIR A RECALCULADORA NO GATILHO. A migration 20261003083400
-- fechou essa porta porque o +10 havia aparecido POR ACIDENTE (74 de 200
-- alunos) junto com situacao, criticidade e proxima acao reescritas, e
-- recalcular_situacao_aluno (13.357 chars) e compartilhada por outros
-- chamadores. Aqui a tabulacao e escrita de forma DELIBERADA e minima no
-- proprio registro; o gatilho e a recalculadora NAO sao tocados.
--
-- O QUE MUDA:
--   1. registrar_acao_massiva passa a gravar, para quem foi registrado:
--      status_acionamento = 'Ação massiva externa enviada — aguardando retorno'
--      e data_retorno = current_date + 10 (origem AUTOMATICO), em alunos e,
--      espelhado, em casos -- porque fn_sync_acionamento_alunos_para_casos
--      sincroniza SO data_ultimo_acionamento, nunca o retorno.
--   2. acoes_massivas_exportar_emails_do_lote (que insere as movimentacoes
--      direto, sem passar por registrar_acao_massiva) faz o mesmo.
--   3. O retorno volta no JSON como 'tabulados'.
--
-- O QUE NAO MUDA, DE PROPOSITO:
--   * status_jornada / status_atual NAO sao tocados. Isso e deliberado:
--     trg_tabulacao_efeito_financeiro e trg_tabulacao_redireciona so disparam
--     quando status_jornada muda, e nenhum efeito financeiro, encaminhamento
--     ou troca de responsavel pode nascer de uma acao massiva;
--   * retorno FUTURO marcado pelo OPERADOR (retorno_origem like 'OPERADOR%')
--     e preservado -- a regra "respeitar o que ja esta agendado";
--   * elegibilidade da propria acao massiva NAO muda: acoes_massivas_universo
--     so bloqueia retorno futuro quando a origem e OPERADOR%, e o que separa
--     um disparo do outro continua sendo a recencia por canal (padrao 10 dias);
--   * NAO ha backfill: os 300 alunos do lote de hoje, os 74 de 02-03/10 e os
--     6.294 com status antigo ficam como estao;
--   * fidelizacao, responsavel, acordo, pagamento, baixa e titulo: intocados.
--
-- TECNICA: patch ANCORADO sobre pg_get_functiondef, nao reescrita do corpo.
-- Cada ancora e conferida por unicidade e o md5 de entrada de cada funcao e
-- exigido, de modo que qualquer deriva de producao faz a migration falhar alto
-- em vez de sobrescrever outra versao.

-- ------------------------------------------------------- 0. preflight (md5)
do $pre$
declare
  v_md5_reg  text;
  v_md5_mail text;
  v_md5_txt  text;
begin
  select md5(prosrc) into v_md5_reg
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.oid = 'public.registrar_acao_massiva(text[],text,text,text,text,text,uuid,jsonb)'::regprocedure;

  select md5(prosrc) into v_md5_mail
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.oid = 'public.acoes_massivas_exportar_emails_do_lote(uuid,text)'::regprocedure;

  if v_md5_reg is distinct from '7de4ee7830af47a4acec47d18a824e29' then
    raise exception 'registrar_acao_massiva mudou em producao (md5 %). Reavaliar o patch.', v_md5_reg
      using errcode = '55000';
  end if;
  if v_md5_mail is distinct from 'd37ddd499e81cc5381762cd8c95f25aa' then
    raise exception 'acoes_massivas_exportar_emails_do_lote mudou em producao (md5 %). Reavaliar o patch.', v_md5_mail
      using errcode = '55000';
  end if;

  -- O texto da tabulacao e o que JA existe na base: um erro de digitacao ou de
  -- encoding no literal tem de falhar aqui, nao virar um status novo.
  v_md5_txt := md5('Ação massiva externa enviada — aguardando retorno');
  if v_md5_txt is distinct from 'dda8af31f097061065008a4f34434565' then
    raise exception 'Literal da tabulacao divergente (md5 %): esperado o valor ja usado em 6.294 alunos.', v_md5_txt
      using errcode = '55000';
  end if;
end;
$pre$;

-- --------------------------------------- 1. registrar_acao_massiva: tabulacao
do $patch$
declare
  v_def text;
  v_novo text;
  v_a_decl text;
  v_a_tab  text;
  v_a_ret  text;
begin
  v_def := pg_get_functiondef(
    'public.registrar_acao_massiva(text[],text,text,text,text,text,uuid,jsonb)'::regprocedure);

  v_a_decl := $a$  v_mot text;
begin$a$;

  v_a_tab := $a$  v_contatos := coalesce(($a$;

  v_a_ret := $a$    'ja_registrados', v_ja,$a$;

  -- Unicidade de cada ancora: 2 ocorrencias = patch no lugar errado.
  if (length(v_def) - length(replace(v_def, v_a_decl, ''))) / length(v_a_decl) <> 1 then
    raise exception 'Ancora do declare nao e unica em registrar_acao_massiva.' using errcode = '55000';
  end if;
  if (length(v_def) - length(replace(v_def, v_a_tab, ''))) / length(v_a_tab) <> 1 then
    raise exception 'Ancora da tabulacao nao e unica em registrar_acao_massiva.' using errcode = '55000';
  end if;
  if (length(v_def) - length(replace(v_def, v_a_ret, ''))) / length(v_a_ret) <> 1 then
    raise exception 'Ancora do retorno nao e unica em registrar_acao_massiva.' using errcode = '55000';
  end if;

  v_novo := replace(v_def, v_a_decl, $a$  v_mot text;
  v_tab int := 0;
begin$a$);

  v_novo := replace(v_novo, v_a_tab, $a$  -- TABULACAO DA ACAO MASSIVA (gestao, 19/10/2026): "coloque 10 dias, ja esta
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

  v_contatos := coalesce(($a$);

  v_novo := replace(v_novo, v_a_ret, $a$    'ja_registrados', v_ja,
    'tabulados', v_tab,$a$);

  if v_novo = v_def then
    raise exception 'Patch de registrar_acao_massiva nao mudou nada.' using errcode = '55000';
  end if;

  execute v_novo;
end;
$patch$;

-- ------------------- 2. e-mail derivado do lote de WhatsApp: mesma tabulacao
-- Esta funcao NAO chama registrar_acao_massiva: ela insere as movimentacoes
-- direto (insert ... select from unnest). Sem este segundo patch, a acao de
-- e-mail derivada do lote continuaria sem tabular.
do $patch$
declare
  v_def text;
  v_novo text;
  v_a text;
begin
  v_def := pg_get_functiondef('public.acoes_massivas_exportar_emails_do_lote(uuid,text)'::regprocedure);

  v_a := $a$  get diagnostics v_reg = row_count;$a$;

  if (length(v_def) - length(replace(v_def, v_a, ''))) / length(v_a) <> 1 then
    raise exception 'Ancora nao e unica em acoes_massivas_exportar_emails_do_lote.' using errcode = '55000';
  end if;

  v_novo := replace(v_def, v_a, $a$  get diagnostics v_reg = row_count;

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
  end if;$a$);

  if v_novo = v_def then
    raise exception 'Patch de acoes_massivas_exportar_emails_do_lote nao mudou nada.' using errcode = '55000';
  end if;

  execute v_novo;
end;
$patch$;

-- ------------------------------------------------------ 3. pos-condicoes
do $pos$
declare
  v_reg text;
  v_mail text;
  v_reg_cod text;
  v_mail_cod text;
begin
  select prosrc into v_reg
    from pg_proc
   where oid = 'public.registrar_acao_massiva(text[],text,text,text,text,text,uuid,jsonb)'::regprocedure;
  select prosrc into v_mail
    from pg_proc
   where oid = 'public.acoes_massivas_exportar_emails_do_lote(uuid,text)'::regprocedure;

  if v_reg !~ 'Ação massiva externa enviada — aguardando retorno'
     or v_reg !~ 'current_date \+ 10'
     or v_reg !~ 'tabulados' then
    raise exception 'registrar_acao_massiva nao ficou com a tabulacao esperada.' using errcode = '55000';
  end if;
  if v_mail !~ 'Ação massiva externa enviada — aguardando retorno'
     or v_mail !~ 'current_date \+ 10' then
    raise exception 'acoes_massivas_exportar_emails_do_lote nao ficou com a tabulacao esperada.' using errcode = '55000';
  end if;

  -- status_jornada continua FORA do CODIGO das duas funcoes: e a guarda contra
  -- efeito financeiro e encaminhamento nascerem de acao massiva.
  -- Os comentarios sao retirados antes de proibir: o proprio bloco novo
  -- EXPLICA que nao toca status_jornada, e uma proibicao por texto cru
  -- acusaria a explicacao em vez do codigo.
  v_reg_cod  := regexp_replace(v_reg,  '--[^' || chr(10) || ']*', '', 'g');
  v_mail_cod := regexp_replace(v_mail, '--[^' || chr(10) || ']*', '', 'g');
  if v_reg_cod ~ 'status_jornada' or v_mail_cod ~ 'status_jornada' then
    raise exception 'Patch encostou em status_jornada: proibido em acao massiva.' using errcode = '55000';
  end if;
end;
$pos$;
