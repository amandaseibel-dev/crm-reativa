-- BACKFILL DO BOLETO DAS PARCELAS PELA PROCEDENCIA DA FUNCAO ANTIGA
-- =============================================================================
-- O QUE FAZ. Grava `parcelas.boleto` em 748 parcelas criadas por
-- `completar_parcelas_acordo()` antes de 16/09/2026, quando a funcao ainda nao
-- persistia o boleto. O valor vem da propria trilha que a funcao deixou.
--
-- A PROVA, UNICA ACEITA. `_backup_completar_parcelas_lote.id` e sequencia
-- (bigint): grava a ordem de insercao. Em cada iteracao do loop antigo, a linha
-- PARCELA_CRIADA e inserida e, logo depois, a TITULO_QUARENTENA. Logo:
--
--   PARCELA_CRIADA id=N, parcela_id=X  ->  TITULO_QUARENTENA id=N+1
--   mesmo lote, mesmo acordo_id  ->  titulo_snapshot.documento
--   ->  ltrim(documento,'0')  ->  parcelas.id = X
--
-- Medido em 16/09/2026 sobre a trilha inteira: 4.760 de 4.799 PARCELA_CRIADA
-- tem o titulo em N+1; pareamento bijetor; zero casos em ordem invertida. Nao
-- usa numero, valor, vencimento, pagamento nem data.
--
-- O TRIGGER SUPRIMIDO. `trg_recalc_parcela` dispara em UPDATE de QUALQUER coluna
-- e chama `recalcular_situacao_aluno`, que escreve em `alunos` e `casos`. Sem
-- supressao, este backfill recalcularia 256 alunos. A gestao decidiu nao aceitar
-- esse efeito e autorizou suprimir EXCLUSIVAMENTE este trigger, pelo nome,
-- durante o UPDATE. Nenhum outro trigger e tocado; nao se usa DISABLE TRIGGER
-- USER/ALL nem session_replication_role.
--
-- COMO A SEGURANCA E PROVADA: POR ESTADO EXPLICITO. O trigger e impedido de
-- rodar, e o estado dele e conferido em `pg_trigger` depois de desligar e depois
-- de religar. As linhas que o trigger escreveria -- `alunos` e `casos` dos 256
-- alunos -- tem hash capturado antes e conferido depois. Qualquer diferenca
-- aborta. A migration nao tenta descobrir em tempo de execucao qual XID escreveu
-- o que.
--
-- RESTAURACAO GARANTIDA. ALTER TABLE ... DISABLE TRIGGER e transacional: qualquer
-- RAISE em qualquer ponto desfaz tambem a supressao.
--
-- IDEMPOTENCIA. O unico caminho de sucesso e 748 candidatas + SHA256 exato ->
-- UPDATE. Depois de aplicado, uma segunda execucao encontra 0 candidatas e
-- ABORTA sem gravar. Zero nunca e tratado como prova de aplicacao anterior.
--
-- NAO FAZ: nao toca as 103 colisoes nem as 1.793 parcelas sem procedencia; nao
-- altera status, pago_em, numero nem qualquer coluna alem de boleto; nao executa
-- o recalculo nem a conciliacao de pagamentos; nao altera a funcao do trigger.

do $backfill$
declare
  -- >>> VALORES APROVADOS PELA GESTAO EM 16/09/2026 --------------------------
  c_hash_aprovado     constant text    := '53d4b1a0169952ca51c979e10f36fa66a31bd33ac1bce7ad5c97ff68dd08cc73';
  c_qtd               constant integer := 748;
  c_acordos           constant integer := 301;
  c_alunos            constant integer := 256;
  c_nulos_antes       constant integer := 2644;
  c_preenchidos_antes constant integer := 12461;
  c_trigger           constant text    := 'trg_recalc_parcela';
  c_trigger_def       constant text    := 'CREATE TRIGGER trg_recalc_parcela AFTER INSERT OR DELETE OR UPDATE ON public.parcelas FOR EACH ROW EXECUTE FUNCTION _trg_recalc_por_parcela()';
  c_funcao_md5        constant text    := '8632b2fcc49b7899fd48dc3801f6a309';
  -- <<< VALORES APROVADOS ----------------------------------------------------

  v_estado text; v_def text; v_md5 text;
  v_trg_antes text; v_outros_antes text; v_outros_desligado text; v_trg_depois text;
  v_n int; v_distintas int; v_acordos int; v_alunos int; v_boletos int; v_rows int; v_x int;
  v_hash text;
  v_nulos int; v_preenchidos int; v_total_antes int; v_total_depois int;
  v_parcelas_sem_boleto_pre text; v_parcelas_sem_boleto_pos text;
  v_boleto_fora_pre text;        v_boleto_fora_pos text;
  v_alunos_pre text;     v_alunos_pos text;
  v_casos_pre text;      v_casos_pos text;
  v_acordos_pre text;    v_acordos_pos text;
  v_titulos_pre text;    v_titulos_pos text;
  v_pagamentos_pre text; v_pagamentos_pos text;
  v_trilha_pre text;     v_trilha_pos text;
  v_quarentena_pre text; v_quarentena_pos text;
begin
  -- 1. nao esperar indefinidamente por lock
  set local lock_timeout = '3s';

  -- lock em parcelas ANTES de validar e recalcular: impede escrita concorrente
  -- entre a checagem e o UPDATE (aprovado na rodada anterior)
  lock table public.parcelas in access exclusive mode;

  -- 2. definicao e estado atual do trigger, e corpo da funcao
  select t.tgenabled::text, pg_get_triggerdef(t.oid) into v_estado, v_def
    from pg_trigger t
   where t.tgrelid = 'public.parcelas'::regclass and t.tgname = c_trigger and not t.tgisinternal;
  if not found then
    raise exception 'ABORTADO: trigger % ausente em public.parcelas', c_trigger;
  end if;
  if v_def is distinct from c_trigger_def then
    raise exception 'ABORTADO: definicao do trigger % diferente da aprovada: %', c_trigger, v_def;
  end if;
  if v_estado is distinct from 'O' then
    raise exception 'ABORTADO: trigger % nao esta habilitado (tgenabled=%)', c_trigger, v_estado;
  end if;
  select md5(p.prosrc) into v_md5
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_trg_recalc_por_parcela';
  if v_md5 is distinct from c_funcao_md5 then
    raise exception 'ABORTADO: corpo de _trg_recalc_por_parcela mudou (md5 %)', v_md5;
  end if;

  select string_agg(tgname||'|'||tgenabled::text||'|'||pg_get_triggerdef(oid), E'\n' order by tgname)
    into v_trg_antes
    from pg_trigger where tgrelid = 'public.parcelas'::regclass and not tgisinternal;
  select string_agg(tgname||'|'||tgenabled::text||'|'||pg_get_triggerdef(oid), E'\n' order by tgname)
    into v_outros_antes
    from pg_trigger where tgrelid = 'public.parcelas'::regclass and not tgisinternal and tgname <> c_trigger;

  -- 3. candidatas, recalculadas pela procedencia, com todos os portoes
  create temp table _cand on commit drop as
  with c as (
    select id, lote, acordo_id, parcela_id
      from public._backup_completar_parcelas_lote where acao = 'PARCELA_CRIADA'
  ), q as (
    select id, lote, acordo_id, titulo_snapshot->>'documento' as doc
      from public._backup_completar_parcelas_lote where acao = 'TITULO_QUARENTENA'
  ), sel as (
    select c.parcela_id, c.acordo_id, c.lote,
           c.id as backup_parcela_id, q.id as backup_titulo_id,
           regexp_replace(q.doc,'\D','','g')            as documento_origem,
           ltrim(regexp_replace(q.doc,'\D','','g'),'0') as boleto_novo
      from c
      join q on q.id = c.id + 1 and q.lote = c.lote and q.acordo_id = c.acordo_id
      join public.parcelas pa on pa.id = c.parcela_id
                             and pa.boleto is null
                             and pa.acordo_id = c.acordo_id
     where ltrim(regexp_replace(q.doc,'\D','','g'),'0') ~ '^5[0-9]{10}$'
       and not exists (select 1 from public.parcelas px
                        where px.boleto = ltrim(regexp_replace(q.doc,'\D','','g'),'0'))
  )
  select s.* from sel s
   where (select count(*) from sel t where t.boleto_novo = s.boleto_novo) = 1;

  select count(*), count(distinct parcela_id), count(distinct acordo_id), count(distinct boleto_novo)
    into v_n, v_distintas, v_acordos, v_boletos from _cand;
  select count(distinct a.aluno_id) into v_alunos
    from _cand c join public.acordos a on a.id = c.acordo_id;

  if v_n = 0 then
    raise exception 'ABORTADO: 0 candidatas. Nada a gravar -- zero NAO prova aplicacao anterior.';
  end if;
  if v_n <> c_qtd then raise exception 'ABORTADO: % candidatas, aprovado %', v_n, c_qtd; end if;
  if v_distintas <> c_qtd then raise exception 'ABORTADO: % parcelas distintas, aprovado %', v_distintas, c_qtd; end if;
  if v_boletos <> c_qtd then raise exception 'ABORTADO: % boletos distintos, aprovado %', v_boletos, c_qtd; end if;
  if v_acordos <> c_acordos then raise exception 'ABORTADO: % acordos, aprovado %', v_acordos, c_acordos; end if;
  if v_alunos <> c_alunos then raise exception 'ABORTADO: % alunos, aprovado %', v_alunos, c_alunos; end if;

  select encode(sha256(convert_to(string_agg(
           parcela_id::text||'|'||acordo_id::text||'|'||lote||'|'||backup_parcela_id::text||'|'||
           backup_titulo_id::text||'|'||documento_origem||'|'||boleto_novo,
           E'\n' order by parcela_id::text collate "C"),'UTF8')),'hex')
    into v_hash from _cand;
  if v_hash is distinct from c_hash_aprovado then
    raise exception 'ABORTADO: SHA256 % difere do aprovado %', v_hash, c_hash_aprovado;
  end if;

  select count(*) into v_x from _cand where backup_titulo_id <> backup_parcela_id + 1;
  if v_x > 0 then raise exception 'ABORTADO: % pares fora de N/N+1', v_x; end if;
  select count(*) into v_x from _cand where boleto_novo !~ '^5[0-9]{10}$';
  if v_x > 0 then raise exception 'ABORTADO: % documentos invalidos', v_x; end if;
  select count(*) into v_x from _cand c join public.parcelas p on p.id = c.parcela_id where p.boleto is not null;
  if v_x > 0 then raise exception 'ABORTADO: % candidatas ja tem boleto', v_x; end if;
  select count(*) into v_x from _cand c join public.parcelas p on p.boleto = c.boleto_novo and p.id <> c.parcela_id;
  if v_x > 0 then raise exception 'ABORTADO: % boletos candidatos ja existem fora do lote', v_x; end if;
  select count(*) into v_x from _cand c join public.parcelas p on p.id = c.parcela_id
   where p.status = 'PAGO' and p.pago_em is null;
  if v_x > 0 then
    raise exception 'ABORTADO: % candidatas PAGO sem pago_em -- o trigger BEFORE alteraria pago_em', v_x;
  end if;

  select count(*) filter (where boleto is null), count(boleto), count(*)
    into v_nulos, v_preenchidos, v_total_antes from public.parcelas;
  if v_nulos <> c_nulos_antes or v_preenchidos <> c_preenchidos_antes then
    raise exception 'ABORTADO: base mudou -- nulos %/% e preenchidos %/% (atual/aprovado)',
      v_nulos, c_nulos_antes, v_preenchidos, c_preenchidos_antes;
  end if;

  -- 4. hashes PRE, sob o lock
  select encode(sha256(convert_to(coalesce(string_agg((to_jsonb(p) - 'boleto')::text, E'\n'
           order by p.id::text collate "C"),''),'UTF8')),'hex')
    into v_parcelas_sem_boleto_pre from public.parcelas p;
  select encode(sha256(convert_to(coalesce(string_agg(p.id::text||'|'||coalesce(p.boleto,'<null>'), E'\n'
           order by p.id::text collate "C"),''),'UTF8')),'hex')
    into v_boleto_fora_pre from public.parcelas p
   where not exists (select 1 from _cand c where c.parcela_id = p.id);

  -- as linhas que o trigger suprimido escreveria: alunos e casos dos 256 alunos
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by to_jsonb(x)::text collate "C"),''),'UTF8')),'hex')
    into v_alunos_pre from public.alunos x
   where x.id in (select a.aluno_id from public.acordos a join _cand c on c.acordo_id = a.id);
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by to_jsonb(x)::text collate "C"),''),'UTF8')),'hex')
    into v_casos_pre from public.casos x
   where x.aluno_id in (select a.aluno_id from public.acordos a join _cand c on c.acordo_id = a.id);

  -- e as demais linhas pertinentes ao lote
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by to_jsonb(x)::text collate "C"),''),'UTF8')),'hex')
    into v_acordos_pre from public.acordos x where x.id in (select acordo_id from _cand);
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by to_jsonb(x)::text collate "C"),''),'UTF8')),'hex')
    into v_titulos_pre from public.acordos_titulos x
   where x.aluno_id in (select a.aluno_id from public.acordos a join _cand c on c.acordo_id = a.id);
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by to_jsonb(x)::text collate "C"),''),'UTF8')),'hex')
    into v_pagamentos_pre from public.pagamentos x
   where x.numero_parcela_completo in (select boleto_novo from _cand);
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by to_jsonb(x)::text collate "C"),''),'UTF8')),'hex')
    into v_trilha_pre from public._backup_completar_parcelas_lote x
   where x.id in (select backup_parcela_id from _cand union select backup_titulo_id from _cand);
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by to_jsonb(x)::text collate "C"),''),'UTF8')),'hex')
    into v_quarentena_pre from public._backup_parcelas_acordo_erro_import x
   where x.id in (select b.titulo_id from public._backup_completar_parcelas_lote b
                   where b.id in (select backup_titulo_id from _cand));

  -- 5. suprime SOMENTE o trigger aprovado
  alter table public.parcelas disable trigger trg_recalc_parcela;

  -- 6. confirma: esse trigger esta D, e os demais continuam exatamente como antes
  select t.tgenabled::text into v_estado
    from pg_trigger t
   where t.tgrelid = 'public.parcelas'::regclass and t.tgname = c_trigger and not t.tgisinternal;
  if v_estado is distinct from 'D' then
    raise exception 'ABORTADO: apos o DISABLE, trigger % nao esta D (tgenabled=%)', c_trigger, v_estado;
  end if;
  select string_agg(tgname||'|'||tgenabled::text||'|'||pg_get_triggerdef(oid), E'\n' order by tgname)
    into v_outros_desligado
    from pg_trigger where tgrelid = 'public.parcelas'::regclass and not tgisinternal and tgname <> c_trigger;
  if v_outros_desligado is distinct from v_outros_antes then
    raise exception 'ABORTADO: outro trigger de parcelas mudou de estado junto com o DISABLE';
  end if;

  -- 7. o unico UPDATE: somente boleto, nunca sobrescreve
  update public.parcelas p
     set boleto = c.boleto_novo
    from _cand c
   where p.id = c.parcela_id
     and p.boleto is null;
  get diagnostics v_rows = row_count;

  -- 8.
  if v_rows <> c_qtd then
    raise exception 'ABORTADO: UPDATE gravou % linhas, aprovado %', v_rows, c_qtd;
  end if;

  -- 9. religa imediatamente
  alter table public.parcelas enable trigger trg_recalc_parcela;

  -- 10. voltou a O, com a mesma definicao e o mesmo corpo de funcao; nada mais mudou
  select t.tgenabled::text, pg_get_triggerdef(t.oid) into v_estado, v_def
    from pg_trigger t
   where t.tgrelid = 'public.parcelas'::regclass and t.tgname = c_trigger and not t.tgisinternal;
  if v_estado is distinct from 'O' then
    raise exception 'ABORTADO: trigger % nao voltou a O (tgenabled=%)', c_trigger, v_estado;
  end if;
  if v_def is distinct from c_trigger_def then
    raise exception 'ABORTADO: definicao do trigger % mudou durante o backfill', c_trigger;
  end if;
  select md5(p.prosrc) into v_md5
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = '_trg_recalc_por_parcela';
  if v_md5 is distinct from c_funcao_md5 then
    raise exception 'ABORTADO: corpo de _trg_recalc_por_parcela mudou durante o backfill';
  end if;
  select string_agg(tgname||'|'||tgenabled::text||'|'||pg_get_triggerdef(oid), E'\n' order by tgname)
    into v_trg_depois
    from pg_trigger where tgrelid = 'public.parcelas'::regclass and not tgisinternal;
  if v_trg_depois is distinct from v_trg_antes then
    raise exception 'ABORTADO: o conjunto de triggers de parcelas nao voltou ao estado inicial';
  end if;

  -- 11. pos-condicoes
  select count(*) into v_x from _cand c join public.parcelas p on p.id = c.parcela_id
   where p.boleto = c.boleto_novo;
  if v_x <> c_qtd then raise exception 'ABORTADO: %/% com o boleto esperado', v_x, c_qtd; end if;

  select count(*) into v_x from _cand c join public.parcelas p on p.id = c.parcela_id where p.boleto is null;
  if v_x > 0 then raise exception 'ABORTADO: % candidatas continuam nulas', v_x; end if;

  select count(*) into v_x from (
    select p.boleto from public.parcelas p where p.boleto in (select boleto_novo from _cand)
     group by p.boleto having count(*) > 1) d;
  if v_x > 0 then raise exception 'ABORTADO: % boletos duplicados apos o update', v_x; end if;

  select count(*) filter (where boleto is null), count(boleto), count(*)
    into v_nulos, v_preenchidos, v_total_depois from public.parcelas;
  if v_nulos <> c_nulos_antes - c_qtd or v_preenchidos <> c_preenchidos_antes + c_qtd
     or v_total_depois <> v_total_antes then
    raise exception 'ABORTADO: contagem pos-backfill errada: nulos % preenchidos % total %',
      v_nulos, v_preenchidos, v_total_depois;
  end if;

  select encode(sha256(convert_to(coalesce(string_agg((to_jsonb(p) - 'boleto')::text, E'\n'
           order by p.id::text collate "C"),''),'UTF8')),'hex')
    into v_parcelas_sem_boleto_pos from public.parcelas p;
  if v_parcelas_sem_boleto_pos is distinct from v_parcelas_sem_boleto_pre then
    raise exception 'ABORTADO: alguma coluna de parcelas alem de boleto mudou';
  end if;
  select encode(sha256(convert_to(coalesce(string_agg(p.id::text||'|'||coalesce(p.boleto,'<null>'), E'\n'
           order by p.id::text collate "C"),''),'UTF8')),'hex')
    into v_boleto_fora_pos from public.parcelas p
   where not exists (select 1 from _cand c where c.parcela_id = p.id);
  if v_boleto_fora_pos is distinct from v_boleto_fora_pre then
    raise exception 'ABORTADO: boleto de parcela FORA das candidatas mudou';
  end if;

  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by to_jsonb(x)::text collate "C"),''),'UTF8')),'hex')
    into v_alunos_pos from public.alunos x
   where x.id in (select a.aluno_id from public.acordos a join _cand c on c.acordo_id = a.id);
  if v_alunos_pos is distinct from v_alunos_pre then
    raise exception 'ABORTADO: alunos dos % alunos do lote mudaram -- o recalculo rodou', c_alunos;
  end if;
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by to_jsonb(x)::text collate "C"),''),'UTF8')),'hex')
    into v_casos_pos from public.casos x
   where x.aluno_id in (select a.aluno_id from public.acordos a join _cand c on c.acordo_id = a.id);
  if v_casos_pos is distinct from v_casos_pre then
    raise exception 'ABORTADO: casos dos % alunos do lote mudaram -- o recalculo rodou', c_alunos;
  end if;

  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by to_jsonb(x)::text collate "C"),''),'UTF8')),'hex')
    into v_acordos_pos from public.acordos x where x.id in (select acordo_id from _cand);
  if v_acordos_pos is distinct from v_acordos_pre then raise exception 'ABORTADO: acordos do lote mudaram'; end if;
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by to_jsonb(x)::text collate "C"),''),'UTF8')),'hex')
    into v_titulos_pos from public.acordos_titulos x
   where x.aluno_id in (select a.aluno_id from public.acordos a join _cand c on c.acordo_id = a.id);
  if v_titulos_pos is distinct from v_titulos_pre then raise exception 'ABORTADO: titulos dos alunos do lote mudaram'; end if;
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by to_jsonb(x)::text collate "C"),''),'UTF8')),'hex')
    into v_pagamentos_pos from public.pagamentos x
   where x.numero_parcela_completo in (select boleto_novo from _cand);
  if v_pagamentos_pos is distinct from v_pagamentos_pre then raise exception 'ABORTADO: pagamentos do lote mudaram'; end if;
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by to_jsonb(x)::text collate "C"),''),'UTF8')),'hex')
    into v_trilha_pos from public._backup_completar_parcelas_lote x
   where x.id in (select backup_parcela_id from _cand union select backup_titulo_id from _cand);
  if v_trilha_pos is distinct from v_trilha_pre then raise exception 'ABORTADO: trilha de procedencia mudou'; end if;
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by to_jsonb(x)::text collate "C"),''),'UTF8')),'hex')
    into v_quarentena_pos from public._backup_parcelas_acordo_erro_import x
   where x.id in (select b.titulo_id from public._backup_completar_parcelas_lote b
                   where b.id in (select backup_titulo_id from _cand));
  if v_quarentena_pos is distinct from v_quarentena_pre then raise exception 'ABORTADO: quarentena do lote mudou'; end if;

  raise notice 'APLICADO: % parcelas com boleto · nulos % -> % · preenchidos % -> % · trigger % de volta a O',
    v_rows, c_nulos_antes, v_nulos, c_preenchidos_antes, v_preenchidos, c_trigger;
end
$backfill$;

