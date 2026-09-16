-- REPROCESSAMENTO CONTROLADO DOS 69 PAGAMENTOS LIGADOS AO BACKFILL #392
-- =============================================================================
-- O QUE FAZ. Chama o motor existente, `pagamento_conciliar_um(id, true)`, uma
-- vez para cada um dos 69 pagamentos `AGUARDANDO_AMARRACAO` cujo boleto passou
-- a existir numa das 748 parcelas restauradas pelo backfill #392
-- (ledger `20260916112956`). Nada alem disso.
--
-- O CONJUNTO, SEM LISTA DE PAGAMENTOS. Um pagamento entra se, e somente se:
--   * o boleto dele (`ltrim(numero_parcela_completo,'0')`, a mesma chave do
--     motor) e o boleto de uma das 748 parcelas do artefato canonico do #392;
--   * `status_conciliacao = 'AGUARDANDO_AMARRACAO'`, sem decisao da gestao na
--     fila -- a mesma selecao de `conciliacao_reprocessar`;
--   * a previa do proprio motor, `pagamento_conciliar_um(id, false)`, devolve
--     `BAIXADO`.
--
-- POR QUE AS 748 VEM COMO IDS DA TRILHA. Depois do backfill, 4.376 pares da
-- trilha tem `parcela.boleto` igual ao boleto da trilha; o portao que separava
-- as 748 (boleto nulo antes do #392) deixou de existir. A identidade do lote e
-- carregada pelos 748 ids `PARCELA_CRIADA` (N) de
-- `_backup_completar_parcelas_lote` -- inteiros da trilha, nao UUIDs -- e a
-- migration so prossegue se esses ids reproduzirem o SHA256 canonico aprovado
-- no #392. Um id errado muda o hash e aborta.
--
-- O QUE NAO FAZ: nao faz UPDATE de status por conta propria; nao usa
-- `baixa_por_documento`, `conciliacao_reprocessar`, `baixa_pelo_relatorio`
-- nem `consulta_portador`; nao altera `fluxo_pagamentos_config`; nao toca nos
-- 95 pagamentos do lote sem `status_conciliacao`; nao reprocessa nenhum outro
-- pagamento da fila.
--
-- EFEITOS ESPERADOS, TODOS DO PROPRIO MOTOR: 69 parcelas `PAGO` com
-- `origem_baixa_ref` do pagamento, `recalcular_situacao_aluno` dos 23 alunos,
-- e 21 acordos fechados como `QUITADO` pelo gatilho da ultima parcela.
--
-- IDEMPOTENCIA. Depois de aplicado, os 69 estao `BAIXADO` e a selecao encontra
-- zero: a migration ABORTA sem gravar. Zero nunca e tratado como prova de
-- aplicacao anterior.

do $reprocessa$
declare
  -- >>> VALORES APROVADOS PELA GESTAO EM 16/09/2026 --------------------------
  c_lote_hash    constant text     := '53d4b1a0169952ca51c979e10f36fa66a31bd33ac1bce7ad5c97ff68dd08cc73';
  c_lote_qtd     constant integer  := 748;
  c_lote_trilha  constant bigint[] := '{
    8,172,210,310,312,314,316,322,518,838,840,842,844,846,848,1182,
    1184,1186,1402,1570,1572,1644,1720,1722,1784,1786,1788,1790,1792,2000,2042,2064,
    2070,2072,2248,2302,2318,2344,2352,2354,2356,2360,2390,2392,2394,2396,2398,2400,
    2402,2430,2432,2434,2436,2438,2442,2492,2530,2584,2650,2672,2746,2748,2794,2800,
    2838,2840,2842,2844,2846,2918,2970,3038,3040,3042,3044,3046,3098,3140,3142,3144,
    3146,3148,3150,3152,3154,3156,3158,3160,3202,3311,3607,3661,3711,3747,3749,3821,
    3823,3925,3927,3929,3931,3933,3935,3945,3987,3999,4001,4003,4005,4007,4009,4011,
    4013,4015,4017,4083,4327,4369,4371,4459,4563,4677,4743,4815,4839,4843,4845,4847,
    5023,5175,5177,5181,5183,5351,5485,5487,5489,5491,5493,5495,5649,5651,5665,5667,
    5685,5687,5689,5691,5693,5695,5747,5781,5825,5827,5829,5831,5833,5835,5837,5839,
    5841,5843,5897,5923,5941,6017,6229,6231,6233,6235,6237,6239,6241,6257,6259,6261,
    6263,6265,6267,6269,6387,6389,6549,6551,6553,6555,6557,6559,6561,6711,6713,6715,
    6717,6719,6721,6765,6941,6943,6945,6947,6949,6951,6953,6995,7305,7359,7491,7585,
    7587,7589,7591,7593,7595,7597,7599,7601,7711,7713,7715,7717,7719,7721,7731,7733,
    7735,7737,7739,7741,7769,7771,7773,7793,7795,7797,7799,7801,7803,7805,7807,7809,
    7811,7813,7815,7817,7819,7821,7823,7827,7829,7831,7833,7835,7837,7839,7841,7843,
    7871,7873,7875,7877,7879,7885,7887,7889,7891,7905,7907,7909,7911,7925,7927,7929,
    7943,7945,7947,7949,7985,7987,7989,7991,7993,7995,7997,7999,8001,8003,8005,8007,
    8009,8021,8023,8025,8027,8029,8031,8037,8045,8049,8051,8085,8087,8089,8091,8093,
    8095,8097,8099,8101,8103,8105,8107,8109,8111,8113,8115,8117,8119,8121,8123,8125,
    8127,8129,8131,8133,8135,8137,8139,8141,8143,8145,8147,8149,8151,8153,8155,8157,
    8159,8161,8163,8165,8167,8169,8171,8173,8175,8203,8205,8207,8209,8211,8213,8281,
    8283,8285,8287,8289,8303,8305,8307,8309,8311,8313,8315,8317,8319,8321,8323,8337,
    8339,8341,8343,8345,8347,8349,8351,8353,8355,8357,8359,8361,8363,8365,8367,8371,
    8397,8399,8401,8403,8405,8431,8433,8435,8437,8439,8441,8443,8445,8461,8463,8465,
    8467,8469,8513,8515,8517,8521,8523,8525,8527,8529,8531,8571,8575,8577,8579,8581,
    8583,8585,8587,8589,8591,8593,8595,8607,8637,8639,8641,8643,8645,8647,8649,8651,
    8653,8655,8657,8659,8673,8675,8677,8679,8681,8683,8685,8687,8689,8691,8693,8697,
    8699,8703,8705,8731,8745,8761,8793,8811,8813,8815,8817,8819,8821,8823,8825,8827,
    8829,8853,8871,8873,8887,8893,8895,8897,8919,8921,8923,8925,8927,8933,8935,8937,
    8947,8949,8967,8981,8983,8985,8987,8989,8991,8993,8995,8997,9011,9013,9015,9017,
    9019,9021,9023,9033,9047,9049,9069,9071,9073,9075,9077,9079,9081,9083,9085,9087,
    9089,9091,9093,9095,9097,9099,9101,9103,9105,9107,9109,9111,9113,9115,9117,9119,
    9121,9123,9125,9127,9129,9131,9133,9135,9137,9139,9141,9143,9145,9147,9149,9151,
    9153,9155,9157,9159,9161,9163,9165,9167,9169,9171,9173,9175,9177,9179,9181,9183,
    9185,9187,9189,9191,9193,9195,9197,9199,9201,9203,9205,9207,9209,9211,9213,9215,
    9217,9219,9221,9223,9225,9227,9229,9231,9233,9235,9237,9239,9241,9243,9245,9247,
    9249,9251,9253,9255,9257,9259,9261,9263,9265,9267,9269,9271,9273,9275,9277,9279,
    9281,9283,9285,9287,9289,9291,9293,9295,9297,9299,9301,9303,9305,9307,9309,9311,
    9313,9315,9317,9319,9321,9323,9325,9327,9329,9331,9333,9335,9337,9339,9341,9343,
    9345,9347,9349,9351,9353,9355,9357,9359,9361,9363,9365,9367,9369,9371,9373,9375,
    9377,9379,9381,9383,9385,9387,9389,9391,9393,9395,9397,9399,9401,9403,9405,9407,
    9409,9411,9413,9415,9417,9419,9421,9423,9425,9427,9429,9431,9433,9435,9437,9439,
    9441,9443,9445,9447,9449,9451,9453,9455,9457,9459,9461,9463,9465,9467,9469,9471,
    9473,9475,9477,9479,9481,9483,9485,9487,9489,9491,9493,9495,9497,9499,9501,9503,
    9505,9507,9509,9511,9513,9515,9517,9519,9521,9523,9525,9527,9529,9531,9533,9535,
    9537,9539,9541,9543,9545,9547,9549,9551,9553,9555,9557,9559
  }';
  c_alvo_hash    constant text     := 'bddd4d68c2da14e24f9f0c95c56629c1ca275bad1b91b1cf1ffaa6cd96c332eb';
  c_qtd          constant integer  := 69;
  c_valor        constant numeric  := 40831.07;
  c_parcelas     constant integer  := 69;
  c_acordos      constant integer  := 23;
  c_alunos       constant integer  := 23;
  c_quitados     constant integer  := 21;
  c_sem_status   constant integer  := 95;
  c_fila_outros  constant text     := 'AGUARDANDO_ACORDO=38;PARCELA_JA_PAGA=6';
  c_motor_md5    constant text     := 'fa3d64add73e0e73e587e16f0c0624d1';
  -- <<< VALORES APROVADOS ----------------------------------------------------

  v_x int; v_txt text; v_md5 text; r record; v_res jsonb;
  v_n int; v_distintos int; v_parcelas int; v_acordos int; v_alunos int; v_valor numeric;
  v_config_pre text;         v_config_pos text;
  v_lote_boleto_pre text;    v_lote_boleto_pos text;
  v_alvo_pag_pre text;       v_alvo_pag_pos text;
  v_alvo_parc_pre text;      v_alvo_parc_pos text;
  v_parc_acordo_pre text;    v_parc_acordo_pos text;
  v_sem_status_pre text;     v_sem_status_pos text;
  v_fila_outros_pre text;    v_fila_outros_pos text;
  v_fila_vinc_pre text;      v_fila_vinc_pos text;
  v_acordo_id_pre text;      v_acordo_id_pos text;
  v_quitar_previstos text;   v_quitados_pos text;
begin
  -- 1. nao esperar indefinidamente por lock
  set local lock_timeout = '3s';

  -- 2. o motor e o que foi auditado, e o fluxo automatico continua pausado
  select count(*), min(md5(p.prosrc)) into v_x, v_md5
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace and p.proname = 'pagamento_conciliar_um';
  if v_x <> 1 then
    raise exception 'ABORTADO: % definicoes de pagamento_conciliar_um, esperado 1', v_x;
  end if;
  if v_md5 is distinct from c_motor_md5 then
    raise exception 'ABORTADO: corpo de pagamento_conciliar_um mudou (md5 %)', v_md5;
  end if;

  if coalesce((select ligado from public.fluxo_pagamentos_config where etapa = 'baixa_pelo_relatorio'), true) then
    raise exception 'ABORTADO: baixa_pelo_relatorio nao esta desligada';
  end if;
  if coalesce((select ligado from public.fluxo_pagamentos_config where etapa = 'baixa_por_documento'), true) then
    raise exception 'ABORTADO: baixa_por_documento nao esta desligada';
  end if;
  if coalesce((select ligado from public.fluxo_pagamentos_config where etapa = 'consulta_portador'), true) then
    raise exception 'ABORTADO: consulta_portador nao esta desligada';
  end if;
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by x.etapa collate "C"),''),'UTF8')),'hex')
    into v_config_pre from public.fluxo_pagamentos_config x;

  -- 3. o lote canonico das 748 parcelas do #392
  create temp table _lote on commit drop as
  select c.parcela_id, c.acordo_id, c.lote,
         c.id as backup_parcela_id, q.id as backup_titulo_id,
         regexp_replace(q.titulo_snapshot->>'documento','\D','','g')            as documento_origem,
         ltrim(regexp_replace(q.titulo_snapshot->>'documento','\D','','g'),'0') as boleto_novo
    from public._backup_completar_parcelas_lote c
    join public._backup_completar_parcelas_lote q
      on q.acao = 'TITULO_QUARENTENA' and q.id = c.id + 1 and q.lote = c.lote and q.acordo_id = c.acordo_id
   where c.acao = 'PARCELA_CRIADA'
     and c.id = any (c_lote_trilha);

  select count(*), count(distinct parcela_id) into v_n, v_distintos from _lote;
  if v_n <> c_lote_qtd or v_distintos <> c_lote_qtd or cardinality(c_lote_trilha) <> c_lote_qtd then
    raise exception 'ABORTADO: lote com % pares / % parcelas / % ids, aprovado %', v_n, v_distintos, cardinality(c_lote_trilha), c_lote_qtd;
  end if;
  select encode(sha256(convert_to(string_agg(
           parcela_id::text||'|'||acordo_id::text||'|'||lote||'|'||backup_parcela_id::text||'|'||
           backup_titulo_id::text||'|'||documento_origem||'|'||boleto_novo,
           E'\n' order by parcela_id::text collate "C"),'UTF8')),'hex')
    into v_txt from _lote;
  if v_txt is distinct from c_lote_hash then
    raise exception 'ABORTADO: SHA256 do lote % difere do artefato do #392 %', v_txt, c_lote_hash;
  end if;
  select count(*) into v_x
    from _lote l left join public.parcelas p on p.id = l.parcela_id
   where p.boleto is distinct from l.boleto_novo;
  if v_x > 0 then
    raise exception 'ABORTADO: % parcelas do lote nao tem mais o boleto restaurado pelo #392', v_x;
  end if;

  -- 4. o conjunto: AGUARDANDO_AMARRACAO ligado ao lote, na ordem da fila do motor
  create temp table _alvo on commit drop as
  select g.id as pagamento_id, g.data_pagamento, g.valor_pago,
         l.parcela_id, p.acordo_id, a.aluno_id,
         row_number() over (order by g.data_pagamento, g.id) as ordem
    from public.pagamentos g
    join _lote l on l.boleto_novo = ltrim(coalesce(g.numero_parcela_completo,''),'0')
    join public.parcelas p on p.id = l.parcela_id
    join public.acordos a on a.id = p.acordo_id
   where g.status_conciliacao = 'AGUARDANDO_AMARRACAO'
     and not exists (select 1 from public.fila_pagamento_sem_vinculo f
                      where f.pagamento_id = g.id and f.decisao is not null);

  select count(*), count(distinct pagamento_id), count(distinct parcela_id),
         count(distinct acordo_id), count(distinct aluno_id), coalesce(sum(valor_pago),0)
    into v_n, v_distintos, v_parcelas, v_acordos, v_alunos, v_valor from _alvo;

  if v_n = 0 then
    raise exception 'ABORTADO: 0 pagamentos no conjunto. Nada a reprocessar -- zero NAO prova aplicacao anterior.';
  end if;
  if v_n <> c_qtd or v_distintos <> c_qtd then
    raise exception 'ABORTADO: % pagamentos no conjunto (% distintos), aprovado %', v_n, v_distintos, c_qtd;
  end if;
  if v_valor <> c_valor then
    raise exception 'ABORTADO: valor do conjunto % difere do aprovado %', v_valor, c_valor;
  end if;
  if v_parcelas <> c_parcelas then raise exception 'ABORTADO: % parcelas, aprovado %', v_parcelas, c_parcelas; end if;
  if v_acordos <> c_acordos then raise exception 'ABORTADO: % acordos, aprovado %', v_acordos, c_acordos; end if;
  if v_alunos <> c_alunos then raise exception 'ABORTADO: % alunos, aprovado %', v_alunos, c_alunos; end if;

  select encode(sha256(convert_to(string_agg(
           pagamento_id::text||'|'||parcela_id::text||'|'||acordo_id::text||'|'||aluno_id::text||'|'||
           valor_pago::text||'|'||data_pagamento::text,
           E'\n' order by ordem),'UTF8')),'hex')
    into v_txt from _alvo;
  if v_txt is distinct from c_alvo_hash then
    raise exception 'ABORTADO: SHA256 do conjunto % difere do aprovado %', v_txt, c_alvo_hash;
  end if;

  -- nenhum AGUARDANDO_AMARRACAO fora do lote pode estar na fila
  select count(*) into v_x
    from public.pagamentos g
   where g.status_conciliacao = 'AGUARDANDO_AMARRACAO'
     and not exists (select 1 from public.fila_pagamento_sem_vinculo f
                      where f.pagamento_id = g.id and f.decisao is not null)
     and g.id not in (select pagamento_id from _alvo);
  if v_x > 0 then
    raise exception 'ABORTADO: % pagamentos AGUARDANDO_AMARRACAO fora do conjunto aprovado', v_x;
  end if;

  -- os pagamentos do lote sem status continuam todos sem status, e fora do conjunto
  select count(*) into v_x
    from public.pagamentos g join _lote l on l.boleto_novo = ltrim(coalesce(g.numero_parcela_completo,''),'0')
   where g.status_conciliacao is null;
  if v_x <> c_sem_status then
    raise exception 'ABORTADO: % pagamentos do lote sem status_conciliacao, aprovado %', v_x, c_sem_status;
  end if;

  -- o restante da fila do motor e exatamente o aprovado
  select coalesce(string_agg(s||'='||n, ';' order by s collate "C"),'') into v_txt
    from (select g.status_conciliacao s, count(*) n
            from public.pagamentos g
           where g.status_conciliacao is not null and g.status_conciliacao <> 'BAIXADO'
             and not exists (select 1 from public.fila_pagamento_sem_vinculo f
                              where f.pagamento_id = g.id and f.decisao is not null)
             and g.id not in (select pagamento_id from _alvo)
           group by 1) t;
  if v_txt is distinct from c_fila_outros then
    raise exception 'ABORTADO: restante da fila % difere do aprovado %', v_txt, c_fila_outros;
  end if;

  -- 5. trava as linhas pertinentes
  perform 1 from public.pagamentos g
   where g.id in (select pagamento_id from _alvo) for no key update of g;
  perform 1 from public.fila_pagamento_sem_vinculo f
   where f.pagamento_id in (select pagamento_id from _alvo) for no key update of f;
  perform 1 from public.acordos a
   where a.id in (select acordo_id from _alvo) for no key update of a;
  perform 1 from public.parcelas p
   where p.acordo_id in (select acordo_id from _alvo) for no key update of p;
  perform 1 from public.pagamentos g
   where g.id not in (select pagamento_id from _alvo)
     and (ltrim(coalesce(g.numero_parcela_completo,''),'0') in (select boleto_novo from _lote)
          or (g.status_conciliacao is not null and g.status_conciliacao <> 'BAIXADO'))
     for share of g;

  -- 6. acordos que o gatilho da ultima parcela deve fechar
  select string_agg(a.id::text, ',' order by a.id::text collate "C"), count(*)
    into v_quitar_previstos, v_x
    from public.acordos a
   where a.id in (select acordo_id from _alvo)
     and upper(coalesce(a.status,'')) = 'ATIVO'
     and not exists (select 1 from public.parcelas p
                      where p.acordo_id = a.id
                        and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA')
                        and p.id not in (select parcela_id from _alvo));
  if v_x <> c_quitados then
    raise exception 'ABORTADO: % acordos seriam quitados, aprovado %', v_x, c_quitados;
  end if;

  -- 7. PRE
  select encode(sha256(convert_to(string_agg(l.parcela_id::text||'|'||coalesce(p.boleto,'<null>'), E'\n'
           order by l.parcela_id::text collate "C"),'UTF8')),'hex')
    into v_lote_boleto_pre from _lote l left join public.parcelas p on p.id = l.parcela_id;
  -- os 69 pagamentos, sem as 3 colunas que o motor grava
  select encode(sha256(convert_to(string_agg((to_jsonb(x) - 'status_conciliacao' - 'conciliacao_motivo' - 'conciliacao_em')::text, E'\n'
           order by x.id::text collate "C"),'UTF8')),'hex')
    into v_alvo_pag_pre from public.pagamentos x where x.id in (select pagamento_id from _alvo);
  -- as 69 parcelas, sem as colunas que a baixa do motor grava
  select encode(sha256(convert_to(string_agg((to_jsonb(x) - 'status' - 'pago_em' - 'confirmado_por_email' - 'origem_baixa'
           - 'origem_baixa_ref' - 'origem_baixa_em' - 'honorarios' - 'observacao' - 'atualizado_em')::text, E'\n'
           order by x.id::text collate "C"),'UTF8')),'hex')
    into v_alvo_parc_pre from public.parcelas x where x.id in (select parcela_id from _alvo);
  -- as demais parcelas dos 23 acordos, inteiras
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by x.id::text collate "C"),''),'UTF8')),'hex')
    into v_parc_acordo_pre from public.parcelas x
   where x.acordo_id in (select acordo_id from _alvo) and x.id not in (select parcela_id from _alvo);
  -- a identidade dos 23 acordos
  select string_agg(x.id::text||'|'||coalesce(x.aluno_id::text,'')||'|'||coalesce(x.numero_ulbra,''), E'\n'
           order by x.id::text collate "C")
    into v_acordo_id_pre from public.acordos x where x.id in (select acordo_id from _alvo);
  -- os pagamentos do lote sem status, inteiros
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by x.id::text collate "C"),''),'UTF8')),'hex')
    into v_sem_status_pre from public.pagamentos x
   where x.status_conciliacao is null
     and ltrim(coalesce(x.numero_parcela_completo,''),'0') in (select boleto_novo from _lote);
  -- o restante da fila do motor, inteiro
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by x.id::text collate "C"),''),'UTF8')),'hex')
    into v_fila_outros_pre from public.pagamentos x
   where x.status_conciliacao is not null and x.status_conciliacao <> 'BAIXADO'
     and x.id not in (select pagamento_id from _alvo);
  -- a fila de pendencias de todos os pagamentos fora do conjunto
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by x.pagamento_id::text collate "C"),''),'UTF8')),'hex')
    into v_fila_vinc_pre from public.fila_pagamento_sem_vinculo x
   where x.pagamento_id not in (select pagamento_id from _alvo);

  -- 8. previa do proprio motor: os 69 tem de sair BAIXADO, sem gravar nada
  for r in select * from _alvo order by ordem loop
    v_res := public.pagamento_conciliar_um(r.pagamento_id, false);
    if v_res->>'status' is distinct from 'BAIXADO'
       or coalesce((v_res->>'aplicou')::boolean, true)
       or (v_res->>'parcela_id') is distinct from r.parcela_id::text then
      raise exception 'ABORTADO: previa do pagamento % (ordem %) devolveu % -- %',
        r.pagamento_id, r.ordem, coalesce(v_res->>'status','(nulo)'), coalesce(v_res->>'motivo','');
    end if;
  end loop;

  -- 9. o motor, uma vez por pagamento, na ordem da fila
  for r in select * from _alvo order by ordem loop
    v_res := public.pagamento_conciliar_um(r.pagamento_id, true);
    if v_res->>'status' is distinct from 'BAIXADO'
       or not coalesce((v_res->>'baixou')::boolean, false)
       or (v_res->>'parcela_id') is distinct from r.parcela_id::text then
      raise exception 'ABORTADO: motor devolveu % para o pagamento % (ordem %) -- rollback total: %',
        coalesce(v_res->>'status','(nulo)'), r.pagamento_id, r.ordem, coalesce(v_res->>'motivo','');
    end if;
  end loop;

  -- 10. pos-condicoes
  select count(*) into v_x from public.pagamentos g
   where g.id in (select pagamento_id from _alvo) and g.status_conciliacao = 'BAIXADO';
  if v_x <> c_qtd then raise exception 'ABORTADO: %/% pagamentos BAIXADO', v_x, c_qtd; end if;

  select count(*) into v_x
    from _alvo t join public.parcelas p on p.id = t.parcela_id
   where upper(coalesce(p.status,'')) = 'PAGO'
     and p.origem_baixa_ref = t.pagamento_id::text
     and p.origem_baixa = 'GATILHO_IMPORTACAO';
  if v_x <> c_parcelas then raise exception 'ABORTADO: %/% parcelas PAGO por este pagamento', v_x, c_parcelas; end if;

  select string_agg(a.id::text, ',' order by a.id::text collate "C"), count(*)
    into v_quitados_pos, v_x
    from public.acordos a
   where a.id in (select acordo_id from _alvo) and upper(coalesce(a.status,'')) = 'QUITADO';
  if v_x <> c_quitados or v_quitados_pos is distinct from v_quitar_previstos then
    raise exception 'ABORTADO: % acordos QUITADO, aprovado % (ou nao sao os previstos)', v_x, c_quitados;
  end if;
  select count(*) into v_x from public.acordos a
   where a.id in (select acordo_id from _alvo) and upper(coalesce(a.status,'')) = 'ATIVO';
  if v_x <> c_acordos - c_quitados then
    raise exception 'ABORTADO: % acordos ATIVO, esperado %', v_x, c_acordos - c_quitados;
  end if;

  select encode(sha256(convert_to(string_agg((to_jsonb(x) - 'status_conciliacao' - 'conciliacao_motivo' - 'conciliacao_em')::text, E'\n'
           order by x.id::text collate "C"),'UTF8')),'hex')
    into v_alvo_pag_pos from public.pagamentos x where x.id in (select pagamento_id from _alvo);
  if v_alvo_pag_pos is distinct from v_alvo_pag_pre then
    raise exception 'ABORTADO: coluna dos 69 pagamentos alem da conciliacao mudou';
  end if;
  select encode(sha256(convert_to(string_agg((to_jsonb(x) - 'status' - 'pago_em' - 'confirmado_por_email' - 'origem_baixa'
           - 'origem_baixa_ref' - 'origem_baixa_em' - 'honorarios' - 'observacao' - 'atualizado_em')::text, E'\n'
           order by x.id::text collate "C"),'UTF8')),'hex')
    into v_alvo_parc_pos from public.parcelas x where x.id in (select parcela_id from _alvo);
  if v_alvo_parc_pos is distinct from v_alvo_parc_pre then
    raise exception 'ABORTADO: coluna das 69 parcelas alem da baixa mudou';
  end if;
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by x.id::text collate "C"),''),'UTF8')),'hex')
    into v_parc_acordo_pos from public.parcelas x
   where x.acordo_id in (select acordo_id from _alvo) and x.id not in (select parcela_id from _alvo);
  if v_parc_acordo_pos is distinct from v_parc_acordo_pre then
    raise exception 'ABORTADO: outra parcela dos acordos do conjunto mudou';
  end if;
  select string_agg(x.id::text||'|'||coalesce(x.aluno_id::text,'')||'|'||coalesce(x.numero_ulbra,''), E'\n'
           order by x.id::text collate "C")
    into v_acordo_id_pos from public.acordos x where x.id in (select acordo_id from _alvo);
  if v_acordo_id_pos is distinct from v_acordo_id_pre then
    raise exception 'ABORTADO: identidade dos acordos do conjunto mudou';
  end if;

  select encode(sha256(convert_to(string_agg(l.parcela_id::text||'|'||coalesce(p.boleto,'<null>'), E'\n'
           order by l.parcela_id::text collate "C"),'UTF8')),'hex')
    into v_lote_boleto_pos from _lote l left join public.parcelas p on p.id = l.parcela_id;
  if v_lote_boleto_pos is distinct from v_lote_boleto_pre then
    raise exception 'ABORTADO: boleto de parcela do lote mudou';
  end if;
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by x.id::text collate "C"),''),'UTF8')),'hex')
    into v_sem_status_pos from public.pagamentos x
   where x.status_conciliacao is null
     and ltrim(coalesce(x.numero_parcela_completo,''),'0') in (select boleto_novo from _lote);
  if v_sem_status_pos is distinct from v_sem_status_pre then
    raise exception 'ABORTADO: pagamento do lote sem status_conciliacao mudou';
  end if;
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by x.id::text collate "C"),''),'UTF8')),'hex')
    into v_fila_outros_pos from public.pagamentos x
   where x.status_conciliacao is not null and x.status_conciliacao <> 'BAIXADO'
     and x.id not in (select pagamento_id from _alvo);
  if v_fila_outros_pos is distinct from v_fila_outros_pre then
    raise exception 'ABORTADO: pagamento da fila fora do conjunto mudou';
  end if;
  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by x.pagamento_id::text collate "C"),''),'UTF8')),'hex')
    into v_fila_vinc_pos from public.fila_pagamento_sem_vinculo x
   where x.pagamento_id not in (select pagamento_id from _alvo);
  if v_fila_vinc_pos is distinct from v_fila_vinc_pre then
    raise exception 'ABORTADO: fila de pendencia de pagamento fora do conjunto mudou';
  end if;

  select encode(sha256(convert_to(coalesce(string_agg(to_jsonb(x)::text, E'\n'
           order by x.etapa collate "C"),''),'UTF8')),'hex')
    into v_config_pos from public.fluxo_pagamentos_config x;
  if v_config_pos is distinct from v_config_pre then
    raise exception 'ABORTADO: fluxo_pagamentos_config mudou';
  end if;

  raise notice 'APLICADO: % pagamentos BAIXADO · R$ % · % parcelas PAGO · % acordos, % QUITADO · % alunos',
    c_qtd, c_valor, c_parcelas, c_acordos, c_quitados, c_alunos;
end
$reprocessa$;
