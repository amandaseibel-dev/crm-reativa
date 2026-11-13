-- MEDICAO PREVIA de 20261113120000_retorno_tratado_nao_herda_selo_do_operador
-- =============================================================================
-- SOMENTE LEITURA. Quatro consultas `select`, nenhuma escreve.
--
-- RESULTADO MEDIDO EM PRODUCAO EM 13/11/2026, 14:31 (Brasilia):
--   1. corpo vivo: md5(prosrc) 41475103b8b7ad363dfdc76c4170c5a8, 13.397
--      caracteres, ancora = 1, patch ausente; definer, search_path=public.
--   2. ramo afetado (COBRANCA_VENCIDA que o motor redata): 10.095 alunos;
--      306 com selo OPERADOR; 1 deles com hora.
--      Confirmados na base inteira: 4 -- todos clicados em 13/11, todos
--      OPERADOR, todos dentro do ramo, todos com retorno de 13/11.
--      => NA VIRADA DE 14/11 MUDARIAM PARA AUTOMATICO: 4 (1 com hora), de 2
--         operadores. Nenhum confirmado fica fora do ramo.
--   3. combinados de hoje, do operador, NAO confirmados, no ramo: 302.
--      Com hora (os unicos que disparam o aviso): 0.
--   4. rastro do clique "Ja falei": 0 linhas em `auditoria`, 0 em
--      `aluno_movimentacoes`. Nao ha evidencia para reconstruir cliques
--      apagados por viradas anteriores.
-- O numero da consulta 2 vale so para a virada seguinte a medicao: REMEDIR no
-- dia da aplicacao.
--
-- -----------------------------------------------------------------------------
-- 1. O CORPO VIVO. md5 e tamanho para o ledger; `ancora` tem de ser 1 e
--    `ja_aplicada` 0. `definicao` e o texto a salvar, byte a byte, como
--    supabase/tests/fixtures/recalcular_situacao_aluno_prod_<data>.sql, para o
--    teste rodar sobre o corpo exato (conferir o md5 do arquivo salvo contra
--    `md5_definicao` -- copiar pelo painel pode trocar fim de linha).
-- -----------------------------------------------------------------------------
select md5(p.prosrc)                       as md5_prosrc,
       length(p.prosrc)                    as chars_prosrc,
       md5(pg_get_functiondef(p.oid))      as md5_definicao,
       (length(p.prosrc) - length(replace(p.prosrc,
          E'elsif v_ret_atual is not null and v_ret_atual > hoje then\n        v_retorno := v_ret_atual;\n        v_origem  := coalesce(nullif(v_orig_atual,''''), ''AUTOMATICO'');\n     else\n        v_retorno := hoje;\n        v_origem  := coalesce(nullif(v_orig_atual,''''), ''AUTOMATICO'');\n     end if;', '')))
         / 281                             as ancora,
       position('al.retorno_confirmado_em is not null' in p.prosrc) > 0 as ja_aplicada,
       p.prosecdef, p.proconfig, p.proacl, p.proowner::regrole as dono,
       pg_get_functiondef(p.oid)           as definicao
  from pg_proc p
 where p.oid = 'public.recalcular_situacao_aluno(uuid,text)'::regprocedure;

-- -----------------------------------------------------------------------------
-- 2. QUANTOS A PROXIMA VIRADA VAI MUDAR. Reproduz, condicao por condicao, o
--    caminho ate a linha trocada -- nao e "quantos estao confirmados".
--    Um aluno so chega la se, na virada de amanha:
--      a) a virada o visita (caso nao quitado);
--      b) cai em COBRANCA_VENCIDA: saldo vencido > 0,005 e nao esta zerado;
--      c) nao tem confirmacao de pagamento pendente (esse ramo zera o retorno);
--      d) nao esta na janela de 10 dias da acao massiva (esse ramo grava +10);
--      e) o retorno nao e futuro em relacao a amanha (data_retorno <= hoje);
--      f) a data vai mudar (data_retorno <> amanha -- sempre verdade com (e));
--      g) esta confirmado ("Ja falei");
--    e o patch so ALTERA o resultado se a origem atual nao for ja AUTOMATICO.
--    `saldo_vencido` e `situacao_operacional` sao os gravados pelo ultimo
--    recalculo -- aproximacao declarada do que a funcao recalcula na hora.
--    "Acionado hoje" (preserva a tabulacao) nao se aplica: na madrugada
--    ninguem foi acionado no dia.
-- -----------------------------------------------------------------------------
with hoje as (select (now() at time zone 'America/Sao_Paulo')::date as d),
base as (
  select a.id, a.retorno_origem, a.data_retorno, a.hora_retorno, a.retorno_confirmado_em,
         a.responsavel_atual_email
    from public.alunos a
    join hoje on true
   where a.retorno_confirmado_em is not null                                   -- (g)
     and a.data_retorno is not null and a.data_retorno <= hoje.d               -- (e)(f)
     and coalesce(a.saldo_vencido, 0) > 0.005                                  -- (b)
     and upper(coalesce(a.situacao_operacional, '')) = 'COBRANCA_VENCIDA'      -- (b)
     and exists (select 1 from public.casos c                                  -- (a)
                  where c.aluno_id = a.id
                    and coalesce(upper(c.situacao_operacional), '') not in ('QUITADO', 'SALDO_ZERO_CONFIRMADO'))
     and not exists (select 1 from public.solicitacoes_confirmacao_pagamento s -- (c)
                      where s.aluno_id = a.id::text and s.status = 'AGUARDANDO_CONFIRMACAO')
     and not (coalesce(a.status_acionamento, '') ilike 'Ação massiva%'         -- (d)
              and a.data_ultimo_acionamento is not null
              and ((hoje.d + 1) - a.data_ultimo_acionamento::date) < 10)
)
select count(*)                                                                    as chegam_na_linha,
       count(*) filter (where upper(coalesce(retorno_origem, '')) like 'OPERADOR%') as mudam_para_automatico,
       count(*) filter (where upper(coalesce(retorno_origem, '')) not like 'OPERADOR%') as ja_eram_automatico_sem_efeito,
       count(*) filter (where upper(coalesce(retorno_origem, '')) like 'OPERADOR%'
                          and nullif(hora_retorno, '') is not null)                as mudam_e_tinham_hora,
       count(distinct responsavel_atual_email)
         filter (where upper(coalesce(retorno_origem, '')) like 'OPERADOR%')       as operadores_envolvidos,
       (select count(*) from public.alunos where retorno_confirmado_em is not null) as confirmados_no_total_para_comparar
  from base;

-- Para o backup por id (rodar no MESMO momento da contagem acima, se a gestao
-- quiser a lista): trocar o `select count(*) ...` final por
--   select id, retorno_origem, data_retorno, hora_retorno, retorno_confirmado_em from base;

-- -----------------------------------------------------------------------------
-- 3. OS QUE JA TIVERAM O "JA FALEI" APAGADO pelas viradas anteriores.
--    O patch NAO os alcanca: sem confirmacao gravada eles sao indistinguiveis,
--    na linha do aluno, de um retorno nao tratado. Esta consulta mede o
--    UNIVERSO onde eles estao (combinado de hoje, do operador, nao confirmado)
--    e quantos tem a data escrita pela maquina -- NAO quantos foram tratados.
--    Sinal usado: a ultima movimentacao do aluno que registrou retorno e de
--    dia anterior ao retorno gravado hoje E a propria linha nao foi acionada
--    hoje. Isso prova "data redatada pelo motor"; nao prova "operador clicou".
-- -----------------------------------------------------------------------------
with hoje as (select (now() at time zone 'America/Sao_Paulo')::date as d),
universo as (
  select a.id, a.hora_retorno, a.data_ultimo_acionamento::date as ult_acion
    from public.alunos a join hoje on true
   where upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%'
     and a.data_retorno = hoje.d
     and a.retorno_confirmado_em is null
)
select count(*)                                                      as combinados_de_hoje_nao_confirmados,
       count(*) filter (where nullif(u.hora_retorno, '') is not null) as com_hora_avisam_hoje,
       count(*) filter (where u.ult_acion is null or u.ult_acion < hoje.d - 1) as sem_acionamento_desde_anteontem,
       count(*) filter (where nullif(u.hora_retorno, '') is not null
                          and (u.ult_acion is null or u.ult_acion < hoje.d - 1)) as com_hora_e_data_provavelmente_da_maquina
  from universo u join hoje on true;

-- -----------------------------------------------------------------------------
-- 4. EXISTE RASTRO DO CLIQUE? Pelo repositorio, `agenda_confirmar_retorno` so
--    grava `alunos.retorno_confirmado_em` -- nao escreve movimentacao nem
--    auditoria. Esta consulta confere se producao tem algo alem disso. Se
--    voltar zero nas duas, NAO HA evidencia confiavel para reconstruir os
--    cliques apagados, e eles nao devem ser reconstruidos.
-- -----------------------------------------------------------------------------
select (select count(*) from public.auditoria
         where coalesce(acao, '') ilike '%retorno%confirm%'
            or coalesce(detalhes::text, '') ilike '%retorno_confirmado_em%')            as linhas_auditoria,
       (select count(*) from public.aluno_movimentacoes
         where coalesce(tipo, '') ilike '%RETORNO%CONFIRM%'
            or coalesce(descricao, '') ilike '%retorno confirmado%'
            or coalesce(descricao, '') ilike '%já falei%')                              as linhas_movimentacao,
       (select string_agg(tgname, ', ') from pg_trigger
         where tgrelid = 'public.alunos'::regclass and not tgisinternal)                as gatilhos_em_alunos;
