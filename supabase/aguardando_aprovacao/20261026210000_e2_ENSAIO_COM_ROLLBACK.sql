-- =====================================================================
-- ENSAIO TRANSACIONAL DA E2 — BEGIN ... ROLLBACK. NAO APLICA NADA.
-- =====================================================================
-- Gerado automaticamente a partir de
--   20261026210000_e2_vinculo_delega_e_proveniencia.sql.pendente
--   md5 do arquivo de origem: 8f4fb7f759623aa6a5a66d0f7e83b6d6
-- A unica diferenca em relacao ao arquivo de origem e que as duas linhas de
-- nivel de script `begin;` e `commit;` foram REMOVIDAS, porque o `commit;` e o
-- unico comando da migration capaz de persistir fora da transacao. Todo o
-- resto entra byte a byte.
--
-- COMO RODAR: cole este arquivo INTEIRO, de uma vez, no SQL Editor. Ele abre a
-- transacao, aplica, valida e DESFAZ. Se qualquer validacao falhar, levanta
-- excecao e a transacao aborta -- o resultado e o mesmo: nada persiste.
--
-- O QUE ELE NAO FAZ: nenhum insert, update ou delete em dado de negocio;
-- nenhuma chamada a vincular_titulos_acordo, titulo_reavaliar ou
-- desvincular_titulos_acordo sobre caso real; nenhum efeito externo. As duas
-- funcoes novas sao SOMENTE LEITURA e sao chamadas sobre acordos reais apenas
-- para ler numeros.
--
-- EFEITO EM OUTRAS SESSOES, declarado: o `create or replace` das tres funcoes
-- pega lock na linha de catalogo de cada uma. Enquanto a transacao estiver
-- aberta, uma chamada concorrente a essas funcoes ESPERA. O ensaio dura
-- segundos e, conferido antes de gerar este arquivo, nenhum dos 43 jobs de cron
-- ativos chama qualquer uma das tres.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- FOTO ANTES
-- ---------------------------------------------------------------------
create temp table _ensaio_antes on commit drop as
select 'md5_vincular'   as chave, (select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='vincular_titulos_acordo') as valor
union all select 'md5_reavaliar',   (select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='titulo_reavaliar')
union all select 'md5_desvincular', (select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='desvincular_titulos_acordo')
union all select 'pagamentos_n',    (select count(*)::text from public.pagamentos)
union all select 'pagamentos_soma', (select round(sum(valor_pago)::numeric,2)::text from public.pagamentos)
union all select 'honorarios_soma', (select round(sum(coalesce(valor_honorario,0))::numeric,2)::text from public.pagamentos)
union all select 'parcelas_n',      (select count(*)::text from public.parcelas)
union all select 'acordos_n',       (select count(*)::text from public.acordos)
union all select 'titulos_n',       (select count(*)::text from public.acordos_titulos)
union all select 'vinculos_n',      (select count(*)::text from public.acordo_titulo_vinculo)
union all select 'vinculos_ativos', (select count(*)::text from public.acordo_titulo_vinculo where coalesce(ativo,true))
union all select 'titulos_pago',    (select count(*)::text from public.acordos_titulos where upper(coalesce(situacao,''))='PAGO')
union all select 'titulos_pago_sem_proveniencia', (select count(*)::text from public.acordos_titulos where upper(coalesce(situacao,''))='PAGO' and origem_liquidacao is null)
union all select 'titulos_negociado',(select count(*)::text from public.acordos_titulos where upper(coalesce(situacao,''))='NEGOCIADO')
union all select 'titulos_aberto',   (select count(*)::text from public.acordos_titulos where upper(coalesce(situacao,''))='ABERTO')
union all select 'gatilhos_n',       (select count(*)::text from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal and c.relname in ('acordos_titulos','acordo_titulo_vinculo','acordos','parcelas'));

select 'FOTO ANTES' as etapa, chave, valor from _ensaio_antes order by chave;

-- =====================================================================
-- A MIGRATION, byte a byte, sem begin/commit
-- =====================================================================
-- =====================================================================
-- E2 — O VINCULADOR DELEGA A DECISÃO FINANCEIRA E A PROVENIÊNCIA É GRAVADA
-- =====================================================================
-- MIGRATION PENDENTE DE APROVAÇÃO. Não aplicada.
--
-- O DEFEITO, medido em produção em 26/10/2026 nos casos Rayssa Lourenço
-- Santiago (título 4510930) e Pedro Henrique (título 4530009):
--
--   `vincular_titulos_acordo` escreve `situacao='PAGO'`/`status='quitada'`
--   DIRETAMENTE, na mesma transação em que grava `acordo_id`. O gatilho
--   `trg_titulo_situacao_por_vinculo` então chama `titulo_reavaliar`, que bate
--   na primeira guarda do motor -- "Ja paga: nada aqui reabre mensalidade
--   quitada" -- e RETORNA SEM FAZER NADA. O motor é o único lugar que grava a
--   trinca `origem_liquidacao/_ref/_em`; calado por essa guarda, a proveniência
--   nunca é gravada.
--
--   Prova no `audit_log`: um ÚNICO UPDATE por título, de
--   `ABERTO/em_aberto/null` para `PAGO/quitada/<acordo>`, com
--   `origem_liquidacao` indo de null para null. Se o motor tivesse agido,
--   haveria um segundo UPDATE.
--
--   Em produção são 798 títulos `PAGO`/`quitada` com `origem_liquidacao = NULL`
--   dentro de 321 acordos cuja soma de mensalidades excede o `valor_total`.
--
-- O SEGUNDO DEFEITO, independente do primeiro: tanto o vinculador quanto o
-- motor decidem quitação por `v_status_acordo = 'QUITADO' and not exists
-- (parcela viva)`. NENHUM DOS DOIS confere se o acordo cobre as mensalidades
-- que estão penduradas nele. No caso da Rayssa um pagamento de R$ 3.313,09
-- quitou R$ 5.739,46 de mensalidade.
--
-- O QUE ESTA MIGRATION FAZ, em quatro blocos independentes:
--
--   1. cria `acordo_cobertura_comprovada` e `acordo_cobertura_detalhe` -- código
--      NOVO, somente leitura, que respondem "o acordo cobre o que está
--      pendurado nele?" e "com quais números?";
--   2. patch ancorado em `vincular_titulos_acordo`: ele para de escrever PAGO e
--      passa a escrever sempre NEGOCIADO/vinculada, delegando a decisão ao
--      motor, que então NÃO está mais calado;
--   3. patch ancorado em `titulo_reavaliar`: a quitação passa a exigir cobertura
--      comprovada, além do status do acordo;
--   4. contenção de `desvincular_titulos_acordo`: portão de gestão, recusa de
--      título com lastro e fim do DELETE em `acordo_titulo_vinculo`.
--
-- POR QUE PATCH ANCORADO E NÃO `CREATE OR REPLACE` COM O CORPO INTEIRO:
-- medido hoje, a árvore do repositório NÃO reproduz produção. O
-- `titulo_reavaliar` do repositório (último arquivo que o define,
-- 20260925123852) tem 5.625 caracteres; o de produção tem 5.903 e md5
-- `a86ab9bf86267fbf4c273a916b072cb7`. Reescrever o corpo exigiria retipar
-- 15.544 e 5.903 caracteres lidos por JSON escapado -- precisamente o caminho
-- que já produziu erro neste projeto. Então cada bloco LÊ o corpo vivo com
-- `pg_get_functiondef`, confere o md5 do `prosrc` ANTES de tocar em nada, troca
-- só o trecho ancorado, confere que a troca aconteceu, e só então executa.
--
-- FALHA FECHADO: md5 diferente do esperado aborta a migration inteira. Âncora
-- não encontrada aborta. Troca que não mudou o texto aborta.
--
-- IDEMPOTENTE PELO TEXTO NOVO: cada bloco verifica primeiro se a marca nova já
-- está presente e, se estiver, não faz nada.
--
-- ZERO DML. Nenhum `insert`, `update`, `delete` ou `truncate` em dado de
-- negócio. Nenhum backfill: os 798 títulos que já estão PAGO sem proveniência
-- continuam exatamente como estão -- a guarda de PAGO do motor, que esta
-- migration NÃO toca, os protege. Esta migration impede a reincidência; a
-- correção dos casos existentes é das funções pontuais, fora daqui.
--
-- RAIO DE IMPACTO da guarda de cobertura, medido em produção em 26/10/2026:
-- de 1.815 acordos QUITADO, 713 não têm título vinculado (a guarda não os
-- alcança), 890 passariam e 212 iriam para conferência (R$ 426.046,17 de
-- descoberto). Os 212 só sentem o efeito em REAVALIAÇÃO FUTURA; nenhum título
-- hoje PAGO muda de estado.
-- =====================================================================


-- ---------------------------------------------------------------------
-- BLOCO 1 — A cobertura, em código novo e somente leitura
-- ---------------------------------------------------------------------
-- A pergunta: o caixa negociado no acordo cobre a soma das mensalidades que
-- têm vínculo ATIVO com ele?
--
-- O teto é `acordos.valor_total` -- o valor pelo qual a dívida foi renegociada.
-- A soma comparada é `valor_original` dos títulos com vínculo ativo.
--
-- ESTA ESCOLHA TEM UM FALSO POSITIVO CONHECIDO, e ele é deliberado: acordo com
-- desconto real tem `valor_total` menor que a soma das mensalidades que
-- substituiu, e esta função dirá que não há cobertura. O título então fica
-- NEGOCIADO em vez de ir para PAGO -- um estado revisável pela gestão. A
-- alternativa (confiar no status do acordo) falha para o outro lado: quita sem
-- lastro e produz cobrança indevida ou dívida perdida. Entre errar para
-- "precisa conferir" e errar para "está pago", esta função erra para o
-- primeiro.
--
-- `valor_cobranca_ajustado` entra quando existe: é o valor cobrável aprovado
-- pela gestão, e é ele que vale sobre `valor_original`.

create or replace function public.acordo_cobertura_detalhe(p_acordo_id uuid)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with t as (
    select coalesce(ti.valor_cobranca_ajustado, ti.valor_original, 0) as valor
      from public.acordo_titulo_vinculo v
      join public.acordos_titulos ti on ti.id = v.titulo_id
     where v.acordo_id = p_acordo_id
       and coalesce(v.ativo, true)
  ),
  a as (
    select coalesce(valor_total, 0) as teto, upper(coalesce(status,'')) as status
      from public.acordos where id = p_acordo_id
  )
  select jsonb_build_object(
    'acordo_id',        p_acordo_id,
    'existe',           (select count(*) from a) > 0,
    'status_acordo',    (select status from a),
    'teto',             (select teto from a),
    'titulos_ativos',   (select count(*) from t),
    'soma_titulos',     (select coalesce(sum(valor), 0) from t),
    'descoberto',       greatest((select coalesce(sum(valor),0) from t) - (select coalesce(teto,0) from a), 0),
    'coberto',          (select count(*) from t) > 0
                          and (select coalesce(sum(valor),0) from t) <= (select coalesce(teto,0) from a)
  );
$function$;

comment on function public.acordo_cobertura_detalhe(uuid) is
  'E2: numeros da cobertura de um acordo -- teto (valor_total), soma dos titulos '
  'com vinculo ativo, descoberto e o booleano coberto. Somente leitura. O teto '
  'por valor_total tem falso positivo conhecido em acordo com desconto real: '
  'nesse caso diz que nao ha cobertura, o titulo fica NEGOCIADO, e a gestao '
  'confere. Erra para "precisa conferir", nunca para "esta pago".';

create or replace function public.acordo_cobertura_comprovada(p_acordo_id uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $function$
  select coalesce((public.acordo_cobertura_detalhe(p_acordo_id) ->> 'coberto')::boolean, false);
$function$;

comment on function public.acordo_cobertura_comprovada(uuid) is
  'E2: o acordo cobre a soma das mensalidades com vinculo ativo nele? Guarda '
  'booleana usada por titulo_reavaliar. Acordo sem titulo vinculado devolve '
  'FALSE -- nao ha o que comprovar, e quitar nesse estado foi o defeito.';

-- Fecha as duas. No schema public deste projeto funcao nova nasce com EXECUTE
-- para authenticated -- e tambem para anon quando a migration e aplicada por
-- supabase_admin (SQL Editor). Como o papel aplicador varia, revogar anon nao e
-- redundancia.
do $$
declare r text; f text;
begin
  foreach f in array array['public.acordo_cobertura_detalhe(uuid)',
                           'public.acordo_cobertura_comprovada(uuid)'] loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f, r);
      end if;
    end loop;
    foreach r in array array['authenticated', 'service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('grant execute on function %s to %I', f, r);
      end if;
    end loop;
  end loop;
end $$;

-- ---------------------------------------------------------------------
-- BLOCO 2 — O vinculador para de decidir quitação
-- ---------------------------------------------------------------------
do $$
declare
  v_md5_esperado constant text := '1ea3ca97f0dea404c299ae2beda50502';
  v_md5          text;
  v_def          text;
  v_novo         text;
  v_ancora_1     constant text :=
'  -- O estado da mensalidade segue o acordo (20260902140000): acordo pago deixa
  -- a mensalidade quitada; acordo ativo deixa negociada.
  v_quitado := v_status_acordo = ''QUITADO''
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = p_acordo_id
         and public.parcela_viva(p.status));';
  v_troca_1      constant text :=
'  -- E2 (26/10/2026): O VINCULADOR NAO DECIDE QUITACAO. Antes, quando o acordo
  -- estava QUITADO sem parcela viva, ele escrevia PAGO/quitada aqui mesmo -- e
  -- com isso calava o motor, porque titulo_reavaliar retorna na guarda de PAGO
  -- e e o motor que grava origem_liquidacao/_ref/_em. Resultado medido: 798
  -- titulos quitados sem proveniencia nenhuma.
  --
  -- Agora o titulo sai sempre NEGOCIADO/vinculada e a decisao financeira e do
  -- motor, chamado pelo gatilho trg_titulo_situacao_por_vinculo no insert do
  -- vinculo logo abaixo. O motor ve NEGOCIADO (nao PAGO), nao retorna na
  -- guarda, exige cobertura comprovada e grava a proveniencia quando quita.
  --
  -- v_quitado continua DECLARADO e deixa de ser usado: as quatro leituras dele
  -- (a atribuicao aqui, o if da escrita e os dois estado_titulo do retorno)
  -- saem juntas nos tres trechos que este bloco troca. Conferido em producao:
  -- nao ha nenhuma quinta ocorrencia no corpo.';
  v_ancora_2     constant text :=
'case when v_quitado then ''quitada'' else ''vinculada'' end';
  v_ancora_3     constant text :=
'  if v_novos is not null then
    if v_quitado then
      update public.acordos_titulos t
         set acordo_id = p_acordo_id, situacao = ''PAGO'', status = ''quitada'',
             motivo_ajuste = coalesce(t.motivo_ajuste,'''')
               || case when coalesce(t.motivo_ajuste,'''') = '''' then '''' else '' | '' end
               || ''quitada junto com o acordo '' || v_numero
               || '': a divida desta mensalidade foi negociada nele e o acordo foi pago'',
             vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
       where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo;
    else
      update public.acordos_titulos t
         set acordo_id = p_acordo_id, situacao = ''NEGOCIADO'', status = ''vinculada'',
             vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
       where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo;
    end if;
    get diagnostics v_n = row_count;
  end if;';
  v_troca_3      constant text :=
'  if v_novos is not null then
    -- E2: UM CAMINHO SO. A bifurcacao saiu inteira em vez de ficar como ramo
    -- morto: deixar a escrita de PAGO no corpo, ainda que inalcancavel, seria
    -- uma armadilha para quem ler a funcao depois.
    update public.acordos_titulos t
       set acordo_id = p_acordo_id, situacao = ''NEGOCIADO'', status = ''vinculada'',
           vinculado_em = now(), vinculado_por = v_email, atualizado_em = now()
     where t.id = any(v_novos) and t.aluno_id = v_aluno_acordo;
    get diagnostics v_n = row_count;
  end if;';
  v_troca_2      constant text :=
'(select string_agg(distinct lower(coalesce(t.status,'''')), '','' order by lower(coalesce(t.status,''''))) from public.acordos_titulos t where t.id = any(p_titulo_ids))';
begin
  select md5(p.prosrc), pg_get_functiondef(p.oid) into v_md5, v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'vincular_titulos_acordo'
     and pg_get_function_identity_arguments(p.oid) = 'p_titulo_ids uuid[], p_acordo_id uuid';

  if v_def is null then
    raise exception 'E2/BLOCO2: vincular_titulos_acordo(uuid[], uuid) nao existe';
  end if;

  -- Idempotencia pelo texto NOVO.
  if position('E2 (26/10/2026): O VINCULADOR NAO DECIDE QUITACAO' in v_def) > 0 then
    raise notice 'E2/BLOCO2: ja aplicado, nada a fazer';
    return;
  end if;

  if v_md5 <> v_md5_esperado then
    raise exception 'E2/BLOCO2: md5 do corpo e % e o esperado e % -- producao mudou desde 26/10/2026, nao vou patchar as cegas',
      v_md5, v_md5_esperado;
  end if;

  if position(v_ancora_1 in v_def) = 0 then
    raise exception 'E2/BLOCO2: ancora 1 (atribuicao de v_quitado) nao encontrada';
  end if;
  if position(v_ancora_2 in v_def) = 0 then
    raise exception 'E2/BLOCO2: ancora 2 (estado_titulo do retorno) nao encontrada';
  end if;
  if position(v_ancora_3 in v_def) = 0 then
    raise exception 'E2/BLOCO2: ancora 3 (bifurcacao da escrita) nao encontrada';
  end if;

  v_novo := replace(v_def,  v_ancora_1, v_troca_1);
  v_novo := replace(v_novo, v_ancora_2, v_troca_2);
  v_novo := replace(v_novo, v_ancora_3, v_troca_3);

  if v_novo = v_def then
    raise exception 'E2/BLOCO2: a troca nao alterou o texto';
  end if;
  if position('situacao = ''PAGO''' in v_novo) > 0 then
    raise exception 'E2/BLOCO2: ainda ha escrita de PAGO no corpo novo';
  end if;
  if position('v_quitado :=' in v_novo) > 0 or position('if v_quitado then' in v_novo) > 0 then
    raise exception 'E2/BLOCO2: v_quitado continua em uso no corpo novo';
  end if;

  execute v_novo;
  raise notice 'E2/BLOCO2: vincular_titulos_acordo patchado';
end $$;

-- ---------------------------------------------------------------------
-- BLOCO 3 — A quitação pelo motor passa a exigir cobertura
-- ---------------------------------------------------------------------
do $$
declare
  v_md5_esperado constant text := 'a86ab9bf86267fbf4c273a916b072cb7';
  v_md5          text;
  v_def          text;
  v_novo         text;
  v_ancora       constant text :=
'  v_quitado := v_status_acordo = ''QUITADO''
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = v_acordo
         and upper(coalesce(p.status,'''')) not in (''PAGO'',''CANCELADA'',''RENEGOCIADA'',''DEVOLVIDA'',''SUSPENSA''));';
  v_troca        constant text :=
'  -- E2 (26/10/2026): STATUS DO ACORDO NAO BASTA. A terceira condicao e
  -- cobertura comprovada: a soma das mensalidades com vinculo ativo no acordo
  -- tem de caber no valor pelo qual a divida foi renegociada. Sem isso um
  -- pagamento de R$ 3.313,09 quitava R$ 5.739,46 de mensalidade (caso medido
  -- em 26/10/2026). Quando a cobertura nao se comprova o titulo fica
  -- NEGOCIADO -- nao vai para PAGO e nao volta para ABERTO -- e
  -- acordo_cobertura_detalhe diz com quais numeros.
  v_quitado := v_status_acordo = ''QUITADO''
    and not exists (
      select 1 from public.parcelas p
       where p.acordo_id = v_acordo
         and upper(coalesce(p.status,'''')) not in (''PAGO'',''CANCELADA'',''RENEGOCIADA'',''DEVOLVIDA'',''SUSPENSA''))
    and public.acordo_cobertura_comprovada(v_acordo);';
begin
  select md5(p.prosrc), pg_get_functiondef(p.oid) into v_md5, v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'titulo_reavaliar'
     and pg_get_function_identity_arguments(p.oid) = 'p_titulo uuid';

  if v_def is null then
    raise exception 'E2/BLOCO3: titulo_reavaliar(uuid) nao existe';
  end if;

  if position('E2 (26/10/2026): STATUS DO ACORDO NAO BASTA' in v_def) > 0 then
    raise notice 'E2/BLOCO3: ja aplicado, nada a fazer';
    return;
  end if;

  if v_md5 <> v_md5_esperado then
    raise exception 'E2/BLOCO3: md5 do corpo e % e o esperado e % -- producao mudou desde 26/10/2026, nao vou patchar as cegas',
      v_md5, v_md5_esperado;
  end if;

  if position(v_ancora in v_def) = 0 then
    raise exception 'E2/BLOCO3: ancora (atribuicao de v_quitado) nao encontrada';
  end if;

  v_novo := replace(v_def, v_ancora, v_troca);

  if v_novo = v_def then
    raise exception 'E2/BLOCO3: a troca nao alterou o texto';
  end if;
  if position('acordo_cobertura_comprovada' in v_novo) = 0 then
    raise exception 'E2/BLOCO3: a guarda de cobertura nao entrou no corpo novo';
  end if;
  -- A guarda de PAGO continua intacta: e ela que protege os 798 titulos que ja
  -- estao quitados sem proveniencia de serem tocados por reavaliacao futura.
  if position('-- Ja paga: nada aqui reabre mensalidade quitada.' in v_novo) = 0 then
    raise exception 'E2/BLOCO3: a guarda de PAGO desapareceu do corpo novo';
  end if;

  execute v_novo;
  raise notice 'E2/BLOCO3: titulo_reavaliar patchado';
end $$;

-- ---------------------------------------------------------------------
-- BLOCO 4 — Contenção de desvincular_titulos_acordo
-- ---------------------------------------------------------------------
-- A funcao de hoje, lida em producao (md5 ebd07b0e, 1.030 caracteres):
--
--   * o portao e `lower(coalesce(auth.email(),'')) = ''` -- QUALQUER pessoa
--     logada passa. Nao ha portao de gestao;
--   * forca `situacao = 'ABERTO'` sem conferir pagamento nenhum. Aplicada ao
--     titulo 4530008 do Pedro Henrique, cobraria de novo R$ 826,74 ja
--     recebidos;
--   * da `DELETE` em `acordo_titulo_vinculo`. Toda a guarda de re-acordo de
--     `titulo_reavaliar` le a cadeia de vinculos, INCLUSIVE linhas inativas --
--     apagar vinculo cega a guarda.
--
-- Chamador unico: src/components/VincularMensalidadesAcordo.jsx:188.
--
-- A contencao NAO reescreve a funcao: acrescenta portao de gestao, recusa
-- titulo com lastro, e troca o DELETE por desativacao.
do $$
declare
  v_md5_esperado constant text := 'ebd07b0ec54e64f9ab685928988cb9a5';
  v_md5          text;
  v_def          text;
  v_novo         text;
  v_ancora_1     constant text :=
'  if v_email = '''' then return jsonb_build_object(''ok'',false,''erro'',''NAO_AUTENTICADO''); end if;';
  v_troca_1      constant text :=
'  if v_email = '''' then return jsonb_build_object(''ok'',false,''erro'',''NAO_AUTENTICADO''); end if;

  -- E2/CONTENCAO (26/10/2026): PORTAO DE GESTAO. Antes bastava estar logado.
  if not (coalesce(public.usuario_e_gestao(), false)
          or coalesce(public.usuario_e_diretoria(), false)) then
    return jsonb_build_object(''ok'', false, ''erro'', ''SEM_PERMISSAO_GESTAO'');
  end if;

  -- E2/CONTENCAO: NAO DESVINCULA TITULO COM LASTRO. Titulo com proveniencia de
  -- liquidacao gravada, ou cujo acordo tem parcela PAGO, foi quitado porque
  -- dinheiro entrou. Devolve-lo para ABERTO cobra de novo o que ja foi pago --
  -- e exatamente o caso do titulo 4530008 do Pedro Henrique. Mover atribuicao
  -- de uma quitacao com lastro e outra porta (titulo_atribuicao_corrigir), que
  -- mantem o titulo PAGO.
  if exists (
    select 1 from public.acordos_titulos t
     where t.id = any(p_titulo_ids)
       and (t.origem_liquidacao is not null
            or exists (select 1 from public.parcelas p
                        where p.acordo_id = t.acordo_id
                          and upper(coalesce(p.status,'''')) = ''PAGO''))) then
    return jsonb_build_object(''ok'', false, ''erro'', ''TITULO_COM_LASTRO'',
      ''detalhe'', ''ha titulo com proveniencia de liquidacao ou acordo com parcela PAGO; '' ||
                  ''desvincular devolveria para ABERTO divida ja paga'');
  end if;';
  v_ancora_2     constant text :=
'  delete from public.acordo_titulo_vinculo where titulo_id = any(p_titulo_ids);';
  v_troca_2      constant text :=
'  -- E2/CONTENCAO: DESATIVA, NAO APAGA. A cadeia de vinculos -- inclusive as
  -- linhas inativas -- e o que a guarda de re-acordo de titulo_reavaliar le.
  -- DELETE cegava essa guarda e perdia a composicao do acordo.
  update public.acordo_titulo_vinculo
     set ativo = false
   where titulo_id = any(p_titulo_ids)
     and coalesce(ativo, true);';
begin
  select md5(p.prosrc), pg_get_functiondef(p.oid) into v_md5, v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'desvincular_titulos_acordo'
     and pg_get_function_identity_arguments(p.oid) = 'p_titulo_ids uuid[]';

  if v_def is null then
    raise exception 'E2/BLOCO4: desvincular_titulos_acordo(uuid[]) nao existe';
  end if;

  if position('E2/CONTENCAO (26/10/2026): PORTAO DE GESTAO' in v_def) > 0 then
    raise notice 'E2/BLOCO4: ja aplicado, nada a fazer';
    return;
  end if;

  if v_md5 <> v_md5_esperado then
    raise exception 'E2/BLOCO4: md5 do corpo e % e o esperado e % -- producao mudou desde 26/10/2026, nao vou patchar as cegas',
      v_md5, v_md5_esperado;
  end if;

  if position(v_ancora_1 in v_def) = 0 then
    raise exception 'E2/BLOCO4: ancora 1 (portao de autenticacao) nao encontrada';
  end if;
  if position(v_ancora_2 in v_def) = 0 then
    raise exception 'E2/BLOCO4: ancora 2 (DELETE do vinculo) nao encontrada';
  end if;

  v_novo := replace(v_def,  v_ancora_1, v_troca_1);
  v_novo := replace(v_novo, v_ancora_2, v_troca_2);

  if v_novo = v_def then
    raise exception 'E2/BLOCO4: a troca nao alterou o texto';
  end if;
  if position('delete from public.acordo_titulo_vinculo' in v_novo) > 0 then
    raise exception 'E2/BLOCO4: ainda ha DELETE de vinculo no corpo novo';
  end if;

  execute v_novo;
  raise notice 'E2/BLOCO4: desvincular_titulos_acordo contido';
end $$;


-- =====================================================================
-- VALIDACOES DENTRO DA TRANSACAO
-- =====================================================================

-- V1 — os corpos reais mudaram, e mudaram no que deviam
do $ensaio$
declare v_def text; v_falhas text := '';
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='vincular_titulos_acordo';
  if position('E2 (26/10/2026): O VINCULADOR NAO DECIDE QUITACAO' in v_def) = 0 then v_falhas := v_falhas || 'vincular: marca ausente; '; end if;
  if position('situacao = ''PAGO''' in v_def) > 0                           then v_falhas := v_falhas || 'vincular: ainda escreve PAGO; '; end if;
  if position('if v_quitado then' in v_def) > 0                             then v_falhas := v_falhas || 'vincular: v_quitado ainda em uso; '; end if;
  if position('E2: UM CAMINHO SO' in v_def) = 0                             then v_falhas := v_falhas || 'vincular: caminho unico ausente; '; end if;

  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='titulo_reavaliar';
  if position('acordo_cobertura_comprovada' in v_def) = 0                   then v_falhas := v_falhas || 'motor: guarda de cobertura ausente; '; end if;
  if position('-- Ja paga: nada aqui reabre mensalidade quitada.' in v_def) = 0 then v_falhas := v_falhas || 'motor: GUARDA DE PAGO DESAPARECEU; '; end if;
  if position('origem_liquidacao     = coalesce(origem_liquidacao' in v_def) = 0 then v_falhas := v_falhas || 'motor: gravacao de proveniencia ausente; '; end if;

  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname='desvincular_titulos_acordo';
  if position('SEM_PERMISSAO_GESTAO' in v_def) = 0                          then v_falhas := v_falhas || 'desvincular: portao de gestao ausente; '; end if;
  if position('TITULO_COM_LASTRO' in v_def) = 0                             then v_falhas := v_falhas || 'desvincular: guarda de lastro ausente; '; end if;
  if position('delete from public.acordo_titulo_vinculo' in v_def) > 0      then v_falhas := v_falhas || 'desvincular: DELETE ainda presente; '; end if;

  if v_falhas <> '' then raise exception 'V1 FALHOU: %', v_falhas; end if;
  raise notice 'V1 ok: os tres corpos tem as marcas certas e nenhuma das proibidas';
end $ensaio$;

-- V2 — permissoes das duas funcoes novas
select 'V2 permissoes' as etapa, p.proname,
       coalesce(array_to_string(p.proacl, ','), '(ACL NULA = EXECUTE para PUBLIC)') as acl,
       has_function_privilege('anon',          p.oid, 'EXECUTE') as anon_pode,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_pode,
       has_function_privilege('service_role',  p.oid, 'EXECUTE') as service_role_pode
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in ('acordo_cobertura_detalhe','acordo_cobertura_comprovada')
order by p.proname;

do $ensaio$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
              where n.nspname='public' and p.proname in ('acordo_cobertura_detalhe','acordo_cobertura_comprovada')
                and has_function_privilege('anon', p.oid, 'EXECUTE')) then
    raise exception 'V2 FALHOU: anon tem EXECUTE em funcao nova';
  end if;
  raise notice 'V2 ok: anon sem EXECUTE nas duas funcoes novas';
end $ensaio$;

-- V3 — a cobertura sobre ACORDOS REAIS, somente leitura
select 'V3 cobertura real' as etapa,
       count(*)                                              as acordos_quitados_com_titulo,
       count(*) filter (where (public.acordo_cobertura_detalhe(id) ->> 'coberto')::boolean) as passariam,
       count(*) filter (where not (public.acordo_cobertura_detalhe(id) ->> 'coberto')::boolean) as iriam_para_conferencia
from public.acordos a
where upper(coalesce(a.status,'')) = 'QUITADO'
  and exists (select 1 from public.acordo_titulo_vinculo v where v.acordo_id = a.id and coalesce(v.ativo,true));

-- V4 — o caso que originou a frente, lido e nao tocado
select 'V4 acordo 74229 (Rayssa)' as etapa, public.acordo_cobertura_detalhe(id) as cobertura
from public.acordos where regexp_replace(coalesce(numero_ulbra,''),'[^0-9]','','g') = '74229';

select 'V4 acordo 72618 (Pedro)' as etapa, public.acordo_cobertura_detalhe(id) as cobertura
from public.acordos where regexp_replace(coalesce(numero_ulbra,''),'[^0-9]','','g') = '72618';

-- V5 — compatibilidade com as guardas existentes: os gatilhos seguem todos no lugar
select 'V5 gatilhos' as etapa, count(*) as gatilhos_nas_4_tabelas
from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
where n.nspname='public' and not t.tgisinternal
  and c.relname in ('acordos_titulos','acordo_titulo_vinculo','acordos','parcelas');

-- Sem numero fixo de proposito: a conta certa e "o mesmo de antes", e isso a
-- comparacao das duas fotos resolve. Numero magico envelhece -- este roteiro
-- foi gerado com 41 na cabeca e producao tinha 40.
do $ensaio$
declare v_antes int; v_agora int;
begin
  select valor::int into v_antes from _ensaio_antes where chave = 'gatilhos_n';
  select count(*) into v_agora from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace
   where n.nspname='public' and not t.tgisinternal
     and c.relname in ('acordos_titulos','acordo_titulo_vinculo','acordos','parcelas');
  if v_agora <> v_antes then
    raise exception 'V5 FALHOU: gatilhos nas 4 tabelas eram % e agora sao % -- a E2 nao deve criar nem remover gatilho', v_antes, v_agora;
  end if;
  raise notice 'V5 ok: % gatilhos, os mesmos de antes', v_agora;
end $ensaio$;

-- =====================================================================
-- FOTO DEPOIS e comparacao
-- =====================================================================
create temp table _ensaio_depois on commit drop as
select 'md5_vincular'   as chave, (select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='vincular_titulos_acordo') as valor
union all select 'md5_reavaliar',   (select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='titulo_reavaliar')
union all select 'md5_desvincular', (select md5(prosrc) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='desvincular_titulos_acordo')
union all select 'pagamentos_n',    (select count(*)::text from public.pagamentos)
union all select 'pagamentos_soma', (select round(sum(valor_pago)::numeric,2)::text from public.pagamentos)
union all select 'honorarios_soma', (select round(sum(coalesce(valor_honorario,0))::numeric,2)::text from public.pagamentos)
union all select 'parcelas_n',      (select count(*)::text from public.parcelas)
union all select 'acordos_n',       (select count(*)::text from public.acordos)
union all select 'titulos_n',       (select count(*)::text from public.acordos_titulos)
union all select 'vinculos_n',      (select count(*)::text from public.acordo_titulo_vinculo)
union all select 'vinculos_ativos', (select count(*)::text from public.acordo_titulo_vinculo where coalesce(ativo,true))
union all select 'titulos_pago',    (select count(*)::text from public.acordos_titulos where upper(coalesce(situacao,''))='PAGO')
union all select 'titulos_pago_sem_proveniencia', (select count(*)::text from public.acordos_titulos where upper(coalesce(situacao,''))='PAGO' and origem_liquidacao is null)
union all select 'titulos_negociado',(select count(*)::text from public.acordos_titulos where upper(coalesce(situacao,''))='NEGOCIADO')
union all select 'titulos_aberto',   (select count(*)::text from public.acordos_titulos where upper(coalesce(situacao,''))='ABERTO')
union all select 'gatilhos_n',       (select count(*)::text from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal and c.relname in ('acordos_titulos','acordo_titulo_vinculo','acordos','parcelas'));

select 'COMPARACAO' as etapa, a.chave, a.valor as antes, d.valor as depois,
       case when a.valor = d.valor then 'igual' else 'MUDOU' end as veredito
from _ensaio_antes a join _ensaio_depois d using (chave)
order by case when a.valor = d.valor then 1 else 0 end, a.chave;

-- As TRES md5 DEVEM ter mudado (a migration fez o que prometeu) e TODO O RESTO
-- -- toda linha de negocio -- NAO pode ter mudado.
do $ensaio$
declare v_md5_mudou int; v_negocio_mudou text;
begin
  select count(*) into v_md5_mudou
    from _ensaio_antes a join _ensaio_depois d using (chave)
   where a.chave like 'md5_%' and a.valor <> d.valor;
  if v_md5_mudou <> 3 then
    raise exception 'FOTO FALHOU: esperava as 3 md5 mudadas e % mudaram', v_md5_mudou;
  end if;

  select string_agg(a.chave || ' ' || a.valor || ' -> ' || d.valor, '; ') into v_negocio_mudou
    from _ensaio_antes a join _ensaio_depois d using (chave)
   where a.chave not like 'md5_%' and a.valor <> d.valor;
  if v_negocio_mudou is not null then
    raise exception 'FOTO FALHOU: dado de negocio mudou -- %', v_negocio_mudou;
  end if;

  raise notice 'FOTO ok: as 3 md5 mudaram e NENHUMA linha de negocio mudou';
end $ensaio$;

-- =====================================================================
-- DESFAZ TUDO
-- =====================================================================
rollback;
