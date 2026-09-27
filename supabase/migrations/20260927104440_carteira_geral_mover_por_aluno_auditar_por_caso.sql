-- ---------------------------------------------------------------------------
-- Carteira Geral: o executor passa a percorrer ALUNO (nao item) e a auditoria
-- passa a registrar CADA CASO movido. O desfazer confere TODOS os casos do
-- aluno, sem LIMIT 1.
--
-- POR QUE (medido no lote 559b20bb, 26/09/2026 22:10:05 UTC)
-- A previa expande por aluno: 6 alunos renderam 8 itens, porque Cristovao e
-- Felipe tem duas fichas cada. O executor percorria ITEM, mas ESCREVIA por
-- ALUNO (`update public.casos ... where aluno_id = ...`, e trocar_dono por
-- aluno). Consequencia: na segunda volta do mesmo aluno a revalidacao lia o
-- dono JA como Carteira Geral, nao conferia com a previa e RECUSAVA o item.
--   itens .................. 8
--   linhas de auditoria .... 6
--   recusas ................ 2  <- o executor recusando a si mesmo
-- Os 8 casos se moveram (a escrita e por aluno), mas 2 ficaram sem registro, e
-- a tela informou 2 recusas que nao eram recusas de verdade.
--
-- Efeito colateral da mesma causa: v_movidos e v_retornos contavam ITEM, nao
-- aluno -- "alunos_movidos" dizia 6 para 6 alunos por coincidencia (2 recusados
-- de 8), e o retorno de um aluno com duas fichas seria contado duas vezes.
--
-- O QUE MUDA
-- 1. mover: laco por ALUNO DISTINTO. A revalidacao confere TODOS os casos que a
--    previa listou para aquele aluno, um por um, e a ficha uma vez. Qualquer
--    divergencia recusa o ALUNO INTEIRO antes de escrever -- mesma regra
--    tudo-ou-nada que ja valia para acordo.
-- 2. mover: recusa tambem o aluno que ganhou um caso NOVO depois da previa.
--    A escrita e `where aluno_id`, entao ela alcançaria um caso que a previa
--    nunca mostrou: melhor recusar do que mover as cegas.
-- 3. mover: UMA LINHA DE AUDITORIA POR CASO. O detalhe dos acordos vai na
--    PRIMEIRA linha do aluno, porque acordo pertence ao ALUNO e nao ao caso --
--    repetir em todas faria o desfazer devolver o mesmo acordo N vezes.
-- 4. mover: alunos_movidos conta ALUNO, casos_movidos (novo) conta CASO, e
--    retornos_preservados conta uma vez por aluno.
-- 5. desfazer: laco por ALUNO (agrupando as linhas), e confere TODOS os casos
--    do lote para aquele aluno -- SEM LIMIT 1. Um caso divergente recusa o
--    aluno inteiro e NENHUMA linha dele e marcada como desfeita.
--
-- COMPATIBILIDADE COM O LOTE 559b20bb (6 linhas para 8 casos)
-- O desfazer monta o conjunto de casos do aluno pela UNIAO de duas fontes: os
-- caso_id que a auditoria registrou E os caso_id que a PREVIA daquele lote
-- listou para o mesmo aluno. E a previa que devolve os 2 casos que a auditoria
-- nao tem. O historico do lote NAO e reescrito: as 6 linhas seguem 6, com os
-- mesmos valores, e e por isso que a reconstrucao vem da previa em vez de
-- INSERTs retroativos.
--
-- O QUE NAO MUDA
-- Assinatura, tipo de retorno, SECURITY DEFINER, search_path, statement_timeout
-- e ACL das duas funcoes. Nada de dado e movido por esta migration.
--
-- Rollback em supabase/rollbacks/.
-- ---------------------------------------------------------------------------

-- PRECONDICAO: so aplica sobre os corpos que esta migration conhece.
do $pre$
declare v_mover text; v_desf text;
begin
  select md5(prosrc) into v_mover from pg_proc
   where oid = 'public.carteira_geral_mover(uuid,text)'::regprocedure;
  select md5(prosrc) into v_desf from pg_proc
   where oid = 'public.carteira_geral_desfazer_lote(uuid,text)'::regprocedure;

  -- IDEMPOTENCIA pelo TEXTO NOVO, nao por md5: o md5 do corpo que esta
  -- migration instala so existe depois de instalado, e chutar um valor seria
  -- pior que nao checar. `casos_movidos` so aparece na versao nova.
  if exists (select 1 from pg_proc
              where oid = 'public.carteira_geral_mover(uuid,text)'::regprocedure
                and prosrc like '%casos_movidos%') then
    raise notice 'ja aplicada: carteira_geral_mover ja conta casos_movidos.';
    return;
  end if;

  -- corpos medidos em producao em 27/09/2026, identicos byte a byte aos do
  -- arquivo 20260925181554 (conferido por md5 do trecho entre $fn$).
  if v_mover <> '44be3995d1ea4de035d2caa285f98535' then
    raise exception 'carteira_geral_mover nao e o corpo esperado (md5 vivo %, esperado 44be3995d1ea4de035d2caa285f98535). Leia a funcao viva e refaca esta migration.', v_mover;
  end if;
  if v_desf <> '2e0d42e1f0c1fe7077e9e1b49e18702d' then
    raise exception 'carteira_geral_desfazer_lote nao e o corpo esperado (md5 vivo %, esperado 2e0d42e1f0c1fe7077e9e1b49e18702d).', v_desf;
  end if;
end
$pre$;

create or replace function public.carteira_geral_mover(p_previa_id uuid, p_motivo text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'internal'
set statement_timeout to '300s'
as $fn$
declare
  v_autor text := lower(coalesce(auth.jwt()->>'email',''));
  v_autor_nome text;
  v_motivo text := nullif(btrim(coalesce(p_motivo,'')),'');
  v_previa public.carteira_geral_previas;
  v_lote uuid := gen_random_uuid();
  v_destino_email text;
  v_destino_nome  text;
  r_al          record;
  it            jsonb;
  ac            jsonb;
  v_caso_agora  text;
  v_aluno_agora text;
  v_ac_email    text;
  v_ac_status   text;
  v_movidos     int := 0;
  v_casos_mov   int := 0;
  v_recusados   jsonb := '[]'::jsonb;
  v_acordos_mov int := 0;
  v_rec_por_acordo int := 0;
  v_falha       text;
  v_ac_falha    text;
  v_ac_detalhe  jsonb;
  v_ac_n        int;
  v_retornos    int := 0;
  v_acordos     jsonb;
  v_casos_previa uuid[];
  v_casos_hoje   uuid[];
  v_primeira     boolean;
begin
  if v_autor = '' then raise exception 'Sessao expirada.' using errcode = '42501'; end if;
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para remanejar carteira.' using errcode = '42501';
  end if;
  if v_motivo is null then
    raise exception 'Informe o motivo do remanejamento.' using errcode = '22023';
  end if;

  select * into v_previa from public.carteira_geral_previas where id = p_previa_id for update;
  if not found then raise exception 'Previa nao encontrada.'; end if;
  if v_previa.executada_em is not null then
    raise exception 'Esta previa ja foi executada em %.', v_previa.executada_em;
  end if;
  if now() > v_previa.expira_em then
    raise exception 'Previa expirada (gerada em %). Gere uma nova.', v_previa.criado_em;
  end if;

  select nome into v_autor_nome from public.usuarios where lower(email) = v_autor limit 1;

  v_destino_email := v_previa.destino_email;
  if v_destino_email is not null then
    select coalesce(u.nome, v_destino_email) into v_destino_nome
      from public.usuarios u where lower(u.email) = lower(v_destino_email);
  end if;

  -- Laco por ALUNO, nao por item: a escrita sempre foi por aluno, e percorrer
  -- item fazia o executor recusar a si mesmo na segunda ficha do mesmo aluno.
  for r_al in
    select (i.value->>'aluno_id')::uuid                      as aluno_id,
           min(i.value->>'nome')                             as nome,
           min(i.value->>'cpf')                              as cpf,
           min(nullif(i.value->>'aluno_de_email',''))        as aluno_de_email,
           min(nullif(i.value->>'caso_de_email',''))         as caso_de_email,
           max(coalesce((i.value->>'saldo_mensalidade')::numeric,0)) as saldo_mensalidade,
           max(coalesce((i.value->>'saldo_acordo')::numeric,0))      as saldo_acordo,
           max(nullif(i.value->>'retorno_data',''))          as retorno_data
      from jsonb_array_elements(v_previa.itens) i
     group by 1
     order by max(coalesce((i.value->>'saldo_total')::numeric,0)) desc
  loop
    v_falha := null;

    -- ---------------- revalidacao: TODOS os casos, um por um ----------------
    select array_agg((i.value->>'caso_id')::uuid)
      into v_casos_previa
      from jsonb_array_elements(v_previa.itens) i
     where (i.value->>'aluno_id')::uuid = r_al.aluno_id
       and nullif(i.value->>'caso_id','') is not null;

    for it in
      select i.value from jsonb_array_elements(v_previa.itens) i
       where (i.value->>'aluno_id')::uuid = r_al.aluno_id
    loop
      select lower(nullif(btrim(coalesce(c.operador_email,'')),''))
        into v_caso_agora
        from public.casos c where c.id = (it->>'caso_id')::uuid;

      if not found then
        v_falha := 'o caso '||coalesce(it->>'caso_id','?')||' nao existe mais';
      elsif coalesce(v_caso_agora,'') is distinct from coalesce(it->>'caso_de_email','') then
        v_falha := 'o dono de um dos casos mudou depois da previa (previa: '||
                   coalesce(nullif(it->>'caso_de_email',''),'ninguem')||', agora: '||
                   coalesce(v_caso_agora,'ninguem')||')';
      end if;
      exit when v_falha is not null;
    end loop;

    -- caso NOVO depois da previa: a escrita e `where aluno_id`, entao ela
    -- alcancaria um caso que a previa nunca mostrou. Melhor recusar.
    if v_falha is null then
      select array_agg(c.id) into v_casos_hoje
        from public.casos c where c.aluno_id = r_al.aluno_id;
      if exists (select 1 from unnest(coalesce(v_casos_hoje,'{}'::uuid[])) x
                  where not (x = any(coalesce(v_casos_previa,'{}'::uuid[])))) then
        v_falha := 'o aluno ganhou um caso novo depois da previa -- gere uma previa nova';
      end if;
    end if;

    -- a ficha, uma vez por aluno
    if v_falha is null then
      select lower(nullif(btrim(coalesce(al.responsavel_atual_email,'')),''))
        into v_aluno_agora
        from public.alunos al where al.id = r_al.aluno_id;
      if coalesce(v_aluno_agora,'') is distinct from coalesce(r_al.aluno_de_email,'') then
        v_falha := 'a ficha do aluno mudou de responsavel depois da previa (previa: '||
                   coalesce(r_al.aluno_de_email,'ninguem')||', agora: '||
                   coalesce(v_aluno_agora,'ninguem')||')';
      end if;
    end if;

    if v_falha is not null then
      v_recusados := v_recusados || jsonb_build_object(
        'nivel', 'ALUNO',
        'aluno_id', r_al.aluno_id, 'nome', r_al.nome,
        'motivo', 'NADA deste aluno foi movido: '||v_falha||'.');
      continue;
    end if;

    -- ---------------- acordos do aluno, sem repetir ------------------------
    -- A previa repete o mesmo array de acordos em cada ficha do aluno; aqui ele
    -- e deduplicado por acordo_id, senao o mesmo acordo seria validado e movido
    -- uma vez por ficha.
    select coalesce(jsonb_agg(z.x), '[]'::jsonb) into v_acordos
      from (select distinct on (a.value->>'acordo_id') a.value as x
              from jsonb_array_elements(v_previa.itens) i,
                   jsonb_array_elements(i.value->'acordos') a
             where (i.value->>'aluno_id')::uuid = r_al.aluno_id
             order by a.value->>'acordo_id') z;

    -- PASSO 1: revalida TODOS os acordos selecionados, SEM ESCREVER.
    v_ac_falha := null;
    for ac in select a.value from jsonb_array_elements(v_acordos) a loop
      if not coalesce((ac->>'mover')::boolean, false) then
        continue;
      end if;

      select lower(coalesce(a.operador_responsavel_email,'')), upper(coalesce(a.status,''))
        into v_ac_email, v_ac_status
        from public.acordos a where a.id = (ac->>'acordo_id')::uuid;

      if not found then
        v_ac_falha := 'o acordo '||coalesce(nullif(ac->>'numero',''), ac->>'acordo_id')||
                      ' nao existe mais';
      elsif v_ac_email is distinct from coalesce(ac->>'de_email','') then
        v_ac_falha := 'o responsavel do acordo '||coalesce(nullif(ac->>'numero',''), ac->>'acordo_id')||
                      ' mudou depois da previa (previa: '||
                      coalesce(nullif(ac->>'de_email',''),'ninguem')||', agora: '||
                      coalesce(nullif(v_ac_email,''),'ninguem')||')';
      elsif v_ac_status is distinct from coalesce(ac->>'status','') then
        v_ac_falha := 'o status do acordo '||coalesce(nullif(ac->>'numero',''), ac->>'acordo_id')||
                      ' mudou depois da previa ('||coalesce(ac->>'status','-')||
                      ' -> '||coalesce(v_ac_status,'-')||')';
      end if;

      exit when v_ac_falha is not null;
    end loop;

    if v_ac_falha is not null then
      v_recusados := v_recusados || jsonb_build_object(
        'nivel', 'ALUNO',
        'aluno_id', r_al.aluno_id, 'nome', r_al.nome,
        'motivo', 'NADA deste aluno foi movido -- caso, ficha, acordos e agenda '||
                  'ficaram como estavam: '||v_ac_falha||'.');
      v_rec_por_acordo := v_rec_por_acordo + 1;
      continue;
    end if;

    -- ---------------- PASSO 2: dai sim, escreve ---------------------------
    v_ac_n := 0;
    v_ac_detalhe := '[]'::jsonb;

    for ac in select a.value from jsonb_array_elements(v_acordos) a loop
      if not coalesce((ac->>'mover')::boolean, false) then
        continue;
      end if;

      perform internal.set_resp_acordo(
        (ac->>'acordo_id')::uuid, v_destino_email, v_destino_nome,
        'CARTEIRA_GERAL_REMANEJAMENTO',
        'Acordo segue o aluno no remanejamento -> '||coalesce(v_destino_nome,'fila livre')||
        '. Motivo: '||v_motivo||'. Lote: '||v_lote::text||'. (autoria do acordo NAO muda)',
        v_autor, coalesce(v_autor_nome, v_autor));

      v_ac_n := v_ac_n + 1;
      v_ac_detalhe := v_ac_detalhe || jsonb_build_object(
        'acordo_id', ac->>'acordo_id',
        'numero', ac->>'numero',
        'de_email', ac->>'de_email',
        'status_no_lote', ac->>'status',
        'de_terceiro', coalesce((ac->>'de_terceiro')::boolean, false),
        'para_email', v_destino_email);
    end loop;

    v_acordos_mov := v_acordos_mov + v_ac_n;

    perform internal.carteira_geral_trocar_dono(
      r_al.aluno_id, v_destino_email, v_destino_nome,
      'CARTEIRA_GERAL_REMANEJAMENTO',
      'Remanejamento em lote -> '||coalesce(v_destino_nome,'fila livre')||'. Motivo: '||v_motivo||
      '. Lote: '||v_lote::text||'. Agendamento de retorno preservado.',
      v_autor, coalesce(v_autor_nome, v_autor));

    update public.casos
       set operador_email = lower(v_destino_email),
           operador_nome  = v_destino_nome,
           operador       = upper(coalesce(v_destino_nome,'')),
           caso_atualizado_por = v_autor,
           caso_atualizado_em  = now()
     where aluno_id = r_al.aluno_id;

    if r_al.retorno_data is not null then
      v_retornos := v_retornos + 1;   -- uma vez por ALUNO: o retorno mora na ficha
    end if;

    -- ---------------- UMA LINHA POR CASO ----------------------------------
    -- O detalhe dos acordos vai so na PRIMEIRA linha do aluno: acordo pertence
    -- ao aluno, e repeti-lo faria o desfazer devolver o mesmo acordo N vezes.
    v_primeira := true;
    for it in
      select i.value from jsonb_array_elements(v_previa.itens) i
       where (i.value->>'aluno_id')::uuid = r_al.aluno_id
       order by i.value->>'caso_id'
    loop
      insert into public.carteira_geral_auditoria
        (previa_id, lote_id, autor_email, autor_nome, motivo, destino_tipo,
         aluno_id, caso_id, nome_aluno, cpf,
         caso_de_email, caso_para_email, aluno_de_email, aluno_para_email,
         acordos_movidos, acordos_detalhe, valor_mensalidade, valor_acordo)
      values
        (p_previa_id, v_lote, v_autor, v_autor_nome, v_motivo, v_previa.destino_tipo,
         r_al.aluno_id, nullif(it->>'caso_id','')::uuid, it->>'nome', it->>'cpf',
         nullif(it->>'caso_de_email',''), v_destino_email,
         nullif(it->>'aluno_de_email',''), v_destino_email,
         case when v_primeira then v_ac_n else 0 end,
         case when v_primeira then v_ac_detalhe else '[]'::jsonb end,
         case when v_primeira then coalesce((it->>'saldo_mensalidade')::numeric,0) else 0 end,
         case when v_primeira then coalesce((it->>'saldo_acordo')::numeric,0) else 0 end);

      v_casos_mov := v_casos_mov + 1;
      v_primeira := false;
    end loop;

    v_movidos := v_movidos + 1;
  end loop;

  update public.carteira_geral_previas
     set executada_em = now(), executada_por_email = v_autor
   where id = p_previa_id;

  return jsonb_build_object(
    'ok', true,
    'lote_id', v_lote,
    'previa_id', p_previa_id,
    'destino_tipo', v_previa.destino_tipo,
    'destino_email', v_destino_email,
    'destino_nome', coalesce(v_destino_nome, 'Fila livre'),
    'alunos_movidos', v_movidos,
    'casos_movidos', v_casos_mov,
    'acordos_movidos', v_acordos_mov,
    'alunos_recusados_por_acordo', v_rec_por_acordo,
    'retornos_preservados', v_retornos,
    'recusados', v_recusados,
    'total_recusados', jsonb_array_length(v_recusados));
end;
$fn$;

-- DEFAULT preservado: `create or replace` que omite o default existente e
-- recusado com 'cannot remove parameter defaults from existing function'.
create or replace function public.carteira_geral_desfazer_lote(p_lote_id uuid, p_motivo text default null::text)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'internal'
set statement_timeout to '300s'
as $fn$
declare
  v_autor text := lower(coalesce(auth.jwt()->>'email',''));
  v_autor_nome text;
  v_motivo text := coalesce(nullif(btrim(coalesce(p_motivo,'')),''), 'Desfazer remanejamento');
  r_al record; ac jsonb;
  v_nome_de text;
  v_caso_agora text; v_aluno_agora text;
  v_ac_email text; v_ac_status text;
  v_bloqueio text;
  v_n int := 0; v_casos int := 0; v_ac int := 0;
  v_recusados jsonb := '[]'::jsonb;
  v_casos_lote uuid[];
  v_acordos jsonb;
  v_caso_id uuid;
begin
  if v_autor = '' then raise exception 'Sessao expirada.' using errcode = '42501'; end if;
  if not public.calibragem_e_gestao() then
    raise exception 'Sem permissao para desfazer remanejamento.' using errcode = '42501';
  end if;

  select nome into v_autor_nome from public.usuarios where lower(email) = v_autor limit 1;

  -- Laco por ALUNO: a partir desta versao o lote tem uma linha POR CASO, e
  -- percorrer linha devolveria o mesmo aluno varias vezes.
  for r_al in
    select a.aluno_id,
           min(a.previa_id::text)::uuid as previa_id,
           min(a.nome_aluno)            as nome_aluno,
           min(a.caso_de_email)         as caso_de_email,
           min(a.caso_para_email)       as caso_para_email,
           min(a.aluno_de_email)        as aluno_de_email,
           min(a.aluno_para_email)      as aluno_para_email
      from public.carteira_geral_auditoria a
     where a.lote_id = p_lote_id and a.desfeito_em is null
     group by a.aluno_id
     order by min(a.registrado_em)
  loop
    v_bloqueio := null;

    -- TODOS os casos que o lote moveu para este aluno. A UNIAO com a previa e o
    -- que torna verificavel um lote gravado ANTES desta migration: o 559b20bb
    -- tem 6 linhas de auditoria para 8 casos, e os 2 que faltam estao na previa.
    -- O historico do lote nao e reescrito -- ele e apenas lido por inteiro.
    select array_agg(distinct z.cid) into v_casos_lote
      from (
        select a.caso_id as cid
          from public.carteira_geral_auditoria a
         where a.lote_id = p_lote_id and a.aluno_id = r_al.aluno_id
           and a.caso_id is not null
        union
        select (i.value->>'caso_id')::uuid
          from public.carteira_geral_previas p,
               jsonb_array_elements(p.itens) i
         where p.id = r_al.previa_id
           and (i.value->>'aluno_id')::uuid = r_al.aluno_id
           and nullif(i.value->>'caso_id','') is not null
      ) z;

    -- Confere CADA caso, sem LIMIT 1. Dois casos em que so um mudou tem de
    -- recusar o aluno inteiro -- era isso que o LIMIT 1 deixava passar,
    -- dependendo de qual linha o banco devolvia.
    foreach v_caso_id in array coalesce(v_casos_lote, '{}'::uuid[]) loop
      select lower(nullif(btrim(coalesce(c.operador_email,'')),''))
        into v_caso_agora
        from public.casos c where c.id = v_caso_id;

      if not found then
        v_bloqueio := 'O caso '||v_caso_id::text||' nao existe mais.';
      elsif v_caso_agora is distinct from lower(nullif(r_al.caso_para_email,'')) then
        v_bloqueio := 'O caso '||v_caso_id::text||' saiu de '||
                      coalesce(nullif(r_al.caso_para_email,''),'fila livre')||
                      ' depois do lote (agora: '||coalesce(v_caso_agora,'fila livre')||
                      '). Foi assumido ou movido de novo -- desfazer apagaria esse trabalho.';
      end if;
      exit when v_bloqueio is not null;
    end loop;

    if v_bloqueio is null then
      select lower(nullif(btrim(coalesce(al.responsavel_atual_email,'')),''))
        into v_aluno_agora
        from public.alunos al where al.id = r_al.aluno_id;
      if v_aluno_agora is distinct from lower(nullif(r_al.aluno_para_email,'')) then
        v_bloqueio := 'A ficha do aluno saiu de '||coalesce(nullif(r_al.aluno_para_email,''),'fila livre')||
                      ' depois do lote (agora: '||coalesce(v_aluno_agora,'fila livre')||').';
      end if;
    end if;

    -- acordos do aluno no lote, uniao das linhas dele
    select coalesce(jsonb_agg(distinct e.x), '[]'::jsonb) into v_acordos
      from public.carteira_geral_auditoria a,
           jsonb_array_elements(a.acordos_detalhe) e(x)
     where a.lote_id = p_lote_id and a.aluno_id = r_al.aluno_id
       and a.desfeito_em is null;

    if v_bloqueio is null then
      for ac in select a.value from jsonb_array_elements(v_acordos) a loop
        select lower(coalesce(a.operador_responsavel_email,'')), upper(coalesce(a.status,''))
          into v_ac_email, v_ac_status
          from public.acordos a where a.id = (ac->>'acordo_id')::uuid;

        if v_ac_email is null then
          v_bloqueio := 'O acordo '||coalesce(nullif(ac->>'numero',''),ac->>'acordo_id')||' nao existe mais.';
          exit;
        end if;
        if v_ac_email is distinct from lower(coalesce(ac->>'para_email','')) then
          v_bloqueio := 'O acordo '||coalesce(nullif(ac->>'numero',''),ac->>'acordo_id')||
                        ' mudou de responsavel depois do lote (agora: '||
                        coalesce(nullif(v_ac_email,''),'ninguem')||').';
          exit;
        end if;
        if v_ac_status is distinct from upper(coalesce(ac->>'status_no_lote','')) then
          v_bloqueio := 'O acordo '||coalesce(nullif(ac->>'numero',''),ac->>'acordo_id')||
                        ' mudou de status depois do lote ('||coalesce(ac->>'status_no_lote','-')||
                        ' -> '||coalesce(v_ac_status,'-')||').';
          exit;
        end if;
      end loop;
    end if;

    if v_bloqueio is not null then
      v_recusados := v_recusados || jsonb_build_object(
        'aluno_id', r_al.aluno_id, 'nome', r_al.nome_aluno, 'motivo', v_bloqueio);
      continue;   -- nenhuma linha deste aluno e marcada como desfeita
    end if;

    select coalesce(u.nome, r_al.aluno_de_email) into v_nome_de
      from public.usuarios u where lower(u.email) = lower(r_al.aluno_de_email);

    for ac in select a.value from jsonb_array_elements(v_acordos) a loop
      perform internal.set_resp_acordo(
        (ac->>'acordo_id')::uuid, nullif(ac->>'de_email',''),
        (select coalesce(u.nome, ac->>'de_email') from public.usuarios u
          where lower(u.email) = lower(ac->>'de_email')),
        'CARTEIRA_GERAL_DESFAZER',
        'Desfeito o lote '||p_lote_id::text||'. Motivo: '||v_motivo||'.',
        v_autor, coalesce(v_autor_nome, v_autor));
      v_ac := v_ac + 1;
    end loop;

    perform internal.carteira_geral_trocar_dono(
      r_al.aluno_id, r_al.aluno_de_email, v_nome_de,
      'CARTEIRA_GERAL_DESFAZER',
      'Desfeito o lote '||p_lote_id::text||'. Motivo: '||v_motivo||'. Agendamento preservado.',
      v_autor, coalesce(v_autor_nome, v_autor));

    update public.casos
       set operador_email = lower(r_al.caso_de_email),
           operador_nome  = v_nome_de,
           operador       = upper(coalesce(v_nome_de,'')),
           caso_atualizado_por = v_autor,
           caso_atualizado_em  = now()
     where aluno_id = r_al.aluno_id;

    v_casos := v_casos + coalesce(array_length(v_casos_lote,1),0);

    update public.carteira_geral_auditoria
       set desfeito_em = now(), desfeito_por_email = v_autor
     where lote_id = p_lote_id and aluno_id = r_al.aluno_id and desfeito_em is null;

    v_n := v_n + 1;
  end loop;

  return jsonb_build_object('ok', true, 'lote_id', p_lote_id,
                            'alunos_devolvidos', v_n,
                            'casos_devolvidos', v_casos,
                            'acordos_devolvidos', v_ac,
                            'recusados', v_recusados,
                            'total_recusados', jsonb_array_length(v_recusados));
end;
$fn$;

revoke all on function public.carteira_geral_mover(uuid,text) from public, anon;
grant execute on function public.carteira_geral_mover(uuid,text) to authenticated;
revoke all on function public.carteira_geral_desfazer_lote(uuid,text) from public, anon;
grant execute on function public.carteira_geral_desfazer_lote(uuid,text) to authenticated;
