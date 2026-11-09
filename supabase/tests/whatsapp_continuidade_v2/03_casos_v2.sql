-- CASOS — CONTINUIDADE v2. 17 cenários.
--
-- Pré-condição: 01_ambiente.sql, 02_antes_v2.sql e a migration
-- 20261109120000_whatsapp_continuidade_v2 aplicados, nesta ordem.
--
-- Canal de teste usa janela 00:00-23:59 para não depender do horário do CI.
-- Todas as mensagens têm idade em HORAS, nunca data absoluta (ver memória:
-- fixture com data absoluta vence e derruba o CI).
--
-- COBERTURA DOS 6 PONTOS PEDIDOS:
--   1. negociação > 72h sem resposta ............... casos 2 e 14
--   2. operadores diferentes na mesma conversa ..... caso 11
--   3. arquivada e depois reaberta ................. casos 7, 8, 9, 10
--   4. limite de 3 envios consecutivos ............. caso 6
--   5. mensagem antiga não gera continuidade ....... casos 2 e 14
--   6. concorrência entre envios simultâneos ....... caso 15
--
-- LIMITE DECLARADO DESTE HARNESS: o caso 15 prova que o lock de linha do
-- canal é adquirido e que a contagem não pode ser ultrapassada em chamadas
-- sequenciais. Uma corrida REAL entre duas conexões simultâneas não é
-- testável num único psql; exigiria duas sessões. Está registrado como
-- limitação, não como aprovado.

\set ON_ERROR_STOP on

do $casos$
declare
  v_canal     uuid;
  v_canal_sr  uuid;  -- SOMENTE_RESPOSTAS
  v_canal_fj  uuid;  -- fora da janela
  v_c         uuid;
  v_c2        uuid;
  v_op1 text := 'op1_cont_v2@test.local';
  v_op2 text := 'op2_cont_v2@test.local';
  v_r text;
  v_n integer;
  v_antes integer;
  v_ult_entrada timestamptz;
  v_lock boolean;
  v_h integer; v_m integer;
begin
  -- Limite alto DE PROPOSITO: este canal testa CLASSIFICACAO, e as abordagens
  -- acumulam ao longo dos casos. Com limite baixo, um caso tardio recebe
  -- LIMITE_OPERADOR em vez do veredito que se quer medir (foi o que derrubou
  -- o caso 16 na execucao 42644515538). O limite em si e testado no caso 15b,
  -- em canal dedicado com limite 2.
  v_canal := public._t_canal('_cont_v2', 'ATIVO_CONTROLADO', 100, null);

  -- ============ 1. o caso relatado: envio anterior foi RESPOSTA ============
  v_c := public._t_conversa(v_canal, '5551900200001');
  perform public._t_msg(v_c, 'ENTRADA', 48);
  perform public._t_msg(v_c, 'SAIDA',   46, v_op1);   -- era RESPOSTA na epoca
  perform public._t_msg(v_c, 'ENTRADA', 40);
  insert into _cont_v2_resultado values ('DEPOIS', 1,
    'envio anterior classificado RESPOSTA, aluno respondeu ha 40h',
    'CONTINUIDADE', public._t_checar(v_canal, v_c, v_op1), null,
    'e o furo da v1: nao havia linha em whatsapp_abordagens');

  -- ============ 2. negociacao esfriada: aluno respondeu ha 80h =============
  v_c := public._t_conversa(v_canal, '5551900200002');
  perform public._t_msg(v_c, 'ENTRADA', 80);
  perform public._t_msg(v_c, 'SAIDA',   79, v_op1);
  insert into _cont_v2_resultado values ('DEPOIS', 2,
    'aluno respondeu ha 80h (fora da janela de 72h)',
    'NOVA_ABORDAGEM', public._t_checar(v_canal, v_c, v_op1), null,
    'cond. 3 — conversa antiga volta a consumir cota');

  -- ============ 3. operador nunca enviou nesta conversa ====================
  v_c := public._t_conversa(v_canal, '5551900200003');
  perform public._t_msg(v_c, 'ENTRADA', 40);
  insert into _cont_v2_resultado values ('DEPOIS', 3,
    'operador NUNCA enviou nesta conversa',
    'NOVA_ABORDAGEM', public._t_checar(v_canal, v_c, v_op1), null,
    'cond. 1 — abordagem legitima');

  -- ============ 4. aluno nunca respondeu ==================================
  v_c := public._t_conversa(v_canal, '5551900200004', 'NOVO');
  perform public._t_msg(v_c, 'SAIDA', 45, v_op1);
  insert into _cont_v2_resultado values ('DEPOIS', 4,
    'operador ja enviou, aluno NUNCA respondeu',
    'NOVA_ABORDAGEM', public._t_checar(v_canal, v_c, v_op1), null,
    'cond. 2 — follow-up frio protege o numero');

  -- ============ 5. precedencia: RESPOSTA ganha de CONTINUIDADE =============
  v_c := public._t_conversa(v_canal, '5551900200005');
  perform public._t_msg(v_c, 'SAIDA',   30, v_op1);
  perform public._t_msg(v_c, 'ENTRADA', 10);
  insert into _cont_v2_resultado values ('DEPOIS', 5,
    'aluno respondeu ha 10h',
    'RESPOSTA', public._t_checar(v_canal, v_c, v_op1), null,
    'precedencia — nao chega em CONTINUIDADE');

  -- ============ 6. teto de insistencia: 3 continuidades, 4a nao ============
  v_c := public._t_conversa(v_canal, '5551900200006');
  -- cond. 1 precisa de envio anterior DESTE operador, e ele tem de ser ANTES
  -- da ultima ENTRADA para a contagem de "sem resposta" comecar em zero.
  -- Sem esta linha o caso 6 media cond.1 falhando, nao o teto de insistencia.
  perform public._t_msg(v_c, 'SAIDA',   50, v_op1);
  perform public._t_msg(v_c, 'ENTRADA', 40);          -- ancora, zera a contagem
  -- 1o envio apos a resposta: 0 envios anteriores desde a ENTRADA
  v_r := public._t_checar(v_canal, v_c, v_op1);
  insert into _cont_v2_resultado values ('DEPOIS', 6,
    'insistencia: 1o envio sem resposta', 'CONTINUIDADE', v_r, null, 'cond. 4');
  perform public._t_msg(v_c, 'SAIDA', 3, v_op1);
  v_r := public._t_checar(v_canal, v_c, v_op1);
  insert into _cont_v2_resultado values ('DEPOIS', 6,
    'insistencia: 2o envio sem resposta', 'CONTINUIDADE', v_r, null, 'cond. 4');
  perform public._t_msg(v_c, 'SAIDA', 2, v_op1);
  v_r := public._t_checar(v_canal, v_c, v_op1);
  insert into _cont_v2_resultado values ('DEPOIS', 6,
    'insistencia: 3o envio sem resposta', 'CONTINUIDADE', v_r, null, 'cond. 4');
  perform public._t_msg(v_c, 'SAIDA', 1, v_op1);
  v_r := public._t_checar(v_canal, v_c, v_op1);
  insert into _cont_v2_resultado values ('DEPOIS', 6,
    'insistencia: 4o envio sem resposta VOLTA a contar', 'NOVA_ABORDAGEM', v_r, null,
    'cond. 4 — teto de 3 atingido');

  -- ============ 7. conversa ARQUIVADA =====================================
  v_c := public._t_conversa(v_canal, '5551900200007', 'EM_ATENDIMENTO', now() - interval '5 hours');
  perform public._t_msg(v_c, 'ENTRADA', 40);
  perform public._t_msg(v_c, 'SAIDA',   39, v_op1);
  insert into _cont_v2_resultado values ('DEPOIS', 7,
    'conversa ARQUIVADA', 'NOVA_ABORDAGEM', public._t_checar(v_canal, v_c, v_op1), null,
    'cond. 5 — eixo arquivamento');

  -- ============ 8. arquivada e DESARQUIVADA ===============================
  update public.whatsapp_conversas set arquivada_em = null, arquivada_por = null where id = v_c;
  delete from public.whatsapp_abordagens where conversa_id = v_c;  -- limpa o efeito do caso 7
  insert into _cont_v2_resultado values ('DEPOIS', 8,
    'mesma conversa DESARQUIVADA, aluno respondeu ha 40h',
    'CONTINUIDADE', public._t_checar(v_canal, v_c, v_op1), null,
    'cond. 5 liberada; demais condicoes ainda valem');

  -- ============ 9. ENCERRADO sem estar arquivada ==========================
  v_c := public._t_conversa(v_canal, '5551900200009', 'ENCERRADO');
  perform public._t_msg(v_c, 'ENTRADA', 40);
  perform public._t_msg(v_c, 'SAIDA',   39, v_op1);
  insert into _cont_v2_resultado values ('DEPOIS', 9,
    'conversa ENCERRADO e NAO arquivada', 'NOVA_ABORDAGEM',
    public._t_checar(v_canal, v_c, v_op1), null,
    'cond. 5 — eixo encerramento, independente do arquivamento');

  -- ============ 10. reaberta de ENCERRADO =================================
  update public.whatsapp_conversas set status = 'EM_ATENDIMENTO' where id = v_c;
  delete from public.whatsapp_abordagens where conversa_id = v_c;
  insert into _cont_v2_resultado values ('DEPOIS', 10,
    'mesma conversa REABERTA de ENCERRADO', 'CONTINUIDADE',
    public._t_checar(v_canal, v_c, v_op1), null,
    'reabrir devolve continuidade sem mexer na ancora do aluno');

  -- ============ 11. dois operadores na mesma conversa =====================
  v_c := public._t_conversa(v_canal, '5551900200011');
  perform public._t_msg(v_c, 'ENTRADA', 44);
  perform public._t_msg(v_c, 'SAIDA',   43, v_op1);
  insert into _cont_v2_resultado values ('DEPOIS', 11,
    'op1 (ja enviou) na conversa compartilhada', 'CONTINUIDADE',
    public._t_checar(v_canal, v_c, v_op1), null, 'identidade do operador');
  delete from public.whatsapp_abordagens where conversa_id = v_c;
  insert into _cont_v2_resultado values ('DEPOIS', 11,
    'op2 (nunca enviou) na MESMA conversa', 'NOVA_ABORDAGEM',
    public._t_checar(v_canal, v_c, v_op2), null,
    'cond. 1 — continuidade nao e transferivel entre operadores');

  -- ============ 12. precedencia SOMENTE_RESPOSTAS ==========================
  v_canal_sr := public._t_canal('_cont_v2_sr', 'SOMENTE_RESPOSTAS', 5, null);
  v_c := public._t_conversa(v_canal_sr, '5551900200012');
  perform public._t_msg(v_c, 'ENTRADA', 40);
  perform public._t_msg(v_c, 'SAIDA',   39, v_op1);
  insert into _cont_v2_resultado values ('DEPOIS', 12,
    'canal em SOMENTE_RESPOSTAS', 'MODO_SOMENTE_RESPOSTAS',
    public._t_checar(v_canal_sr, v_c, v_op1), null,
    'restricao do canal prevalece sobre continuidade');

  -- ============ 13. precedencia FORA_DA_JANELA =============================
  -- Janela de 1 minuto que ja passou, calculada do relogio do proprio CI.
  v_canal_fj := public._t_canal('_cont_v2_fj', 'ATIVO_CONTROLADO', 5, null,
                  '00:00', '00:01');
  v_c := public._t_conversa(v_canal_fj, '5551900200013');
  perform public._t_msg(v_c, 'ENTRADA', 40);
  perform public._t_msg(v_c, 'SAIDA',   39, v_op1);
  v_r := public._t_checar(v_canal_fj, v_c, v_op1);
  insert into _cont_v2_resultado values ('DEPOIS', 13,
    'fora da janela do canal', 'FORA_DA_JANELA', v_r, null,
    'restricao do canal prevalece sobre continuidade');

  -- ============ 14. CONTINUIDADE nao grava e nao renova a janela ===========
  v_c := public._t_conversa(v_canal, '5551900200014');
  perform public._t_msg(v_c, 'ENTRADA', 71);   -- quase no limite de 72h
  perform public._t_msg(v_c, 'SAIDA',   70, v_op1);
  select max(timestamp_wa) into v_ult_entrada from public.whatsapp_mensagens
    where conversa_id = v_c and direcao = 'ENTRADA';
  select count(*) into v_antes from public.whatsapp_abordagens where conversa_id = v_c;
  v_r := public._t_checar(v_canal, v_c, v_op1);
  select count(*) into v_n from public.whatsapp_abordagens where conversa_id = v_c;
  insert into _cont_v2_resultado values ('DEPOIS', 14,
    'CONTINUIDADE nao cria linha em whatsapp_abordagens', 'CONTINUIDADE', v_r, null,
    format('abordagens antes=%s depois=%s', v_antes, v_n));
  insert into _cont_v2_resultado values ('DEPOIS', 14,
    'cota NAO foi consumida pela continuidade',
    '0', (v_n - v_antes)::text, null, 'nao consome e nao realimenta janela');
  -- A ancora segue sendo a ENTRADA original: nenhum envio a moveu.
  insert into _cont_v2_resultado values ('DEPOIS', 14,
    'ancora da janela segue a ENTRADA original (nao renovavel)',
    'true',
    (v_ult_entrada = (select max(timestamp_wa) from public.whatsapp_mensagens
                       where conversa_id = v_c and direcao = 'ENTRADA'))::text,
    null, 'mensagem antiga nao gera continuidade indefinida');

  -- ============ 15. concorrencia: lock do canal e contagem ================
  -- 15a: o lock de linha do canal e realmente adquirido nesta transacao.
  v_c := public._t_conversa(v_canal, '5551900200015');
  perform public._t_checar(v_canal, v_c, v_op1);
  select exists (
    select 1 from pg_locks l join pg_class c on c.oid = l.relation
     where c.relname = 'whatsapp_canais' and l.mode = 'RowShareLock'
       and l.pid = pg_backend_pid() and l.granted
  ) into v_lock;
  insert into _cont_v2_resultado values ('DEPOIS', 15,
    'FOR UPDATE na linha do canal e adquirido', 'true', v_lock::text, null,
    'serializa a cadencia do canal; corrida entre 2 conexoes nao e testavel aqui');

  -- 15b: o limite nao pode ser ultrapassado. Canal dedicado, limite 2.
  declare
    v_canal_lim uuid := public._t_canal('_cont_v2_lim', 'ATIVO_CONTROLADO', 2, null);
    v_i integer;
    v_ultimo text;
  begin
    for v_i in 1..3 loop
      v_c := public._t_conversa(v_canal_lim, '555190020015'||v_i::text);
      v_ultimo := public._t_checar(v_canal_lim, v_c, v_op1);
    end loop;
    insert into _cont_v2_resultado values ('DEPOIS', 15,
      '3a abordagem com limite 2 e barrada', 'LIMITE_OPERADOR', v_ultimo, null,
      'contagem sob o lock');
  end;

  -- ============ 16. continuidade_janela_horas = 0 desliga ==================
  update public.whatsapp_config set continuidade_janela_horas = 0;
  v_c := public._t_conversa(v_canal, '5551900200016');
  perform public._t_msg(v_c, 'ENTRADA', 40);
  perform public._t_msg(v_c, 'SAIDA',   39, v_op1);
  insert into _cont_v2_resultado values ('DEPOIS', 16,
    'continuidade_janela_horas = 0 desliga a classificacao',
    'NOVA_ABORDAGEM', public._t_checar(v_canal, v_c, v_op1), null,
    'volta ao comportamento atual sem rollback');
  update public.whatsapp_config set continuidade_janela_horas = 72;

  -- ============ 17. parametros e grants depois da migration ===============
  select continuidade_janela_horas, continuidade_max_sem_resposta into v_h, v_m
    from public.whatsapp_config limit 1;
  insert into _cont_v2_resultado values ('DEPOIS', 17,
    'continuidade_janela_horas padrao', '72', v_h::text, null, 'parametro');
  insert into _cont_v2_resultado values ('DEPOIS', 17,
    'continuidade_max_sem_resposta padrao', '3', v_m::text, null, 'parametro');
  insert into _cont_v2_resultado values ('DEPOIS', 17,
    'resposta_janela_horas INALTERADA', '24',
    (select resposta_janela_horas from public.whatsapp_config limit 1)::text, null,
    'decisao da Amanda em 09/11');
  insert into _cont_v2_resultado values ('DEPOIS', 17,
    'authenticated mantem EXECUTE na funcao', 'true',
    has_function_privilege('authenticated',
      'public.whatsapp_cadencia_checar(uuid, uuid, text)', 'EXECUTE')::text, null,
    'CREATE OR REPLACE restaura grants padrao');
  insert into _cont_v2_resultado values ('DEPOIS', 17,
    'anon NAO tem EXECUTE na funcao', 'false',
    has_function_privilege('anon',
      'public.whatsapp_cadencia_checar(uuid, uuid, text)', 'EXECUTE')::text, null,
    'premissa de seguranca');

  update _cont_v2_resultado set ok = (obtido = esperado) where fase = 'DEPOIS';
end $casos$;

-- ---------------------------------------------------------------------------
-- RESULTADO
-- ---------------------------------------------------------------------------
select fase, n, caso, esperado, obtido,
       case when ok then 'OK' else 'FALHOU' end as veredito, detalhe
  from _cont_v2_resultado
 order by fase desc, n;

-- COMPARATIVO regra atual x v2.
--
-- O par ANTES/DEPOIS é dado por um mapa EXPLÍCITO, nunca pelo índice: na fase
-- DEPOIS vários casos compartilham o mesmo n (o 6 tem 4 asserções, o 11 tem 2,
-- o 14 tem 3, o 17 tem 5). Casar por n gerava produto cartesiano e inventava
-- "MUDA" entre cenários diferentes — foi o que saiu errado na execução
-- 42658921344, onde o cenário "conversa ARQUIVADA" apareceu 4 vezes pareado
-- com as asserções do teto de insistência.
with mapa(n_antes, n_depois, caso_depois) as (values
  (1,  1, 'envio anterior classificado RESPOSTA, aluno respondeu ha 40h'),
  (2,  2, 'aluno respondeu ha 80h (fora da janela de 72h)'),
  (3,  3, 'operador NUNCA enviou nesta conversa'),
  (4,  4, 'operador ja enviou, aluno NUNCA respondeu'),
  (5, 11, 'op2 (nunca enviou) na MESMA conversa'),
  (6,  7, 'conversa ARQUIVADA')
)
select m.n_antes as n,
       a.caso    as cenario,
       a.obtido  as regra_atual,
       d.obtido  as regra_v2,
       case when a.obtido = d.obtido then 'igual' else 'MUDA' end as efeito
  from mapa m
  join _cont_v2_resultado a on a.fase = 'ANTES'  and a.n = m.n_antes
  join _cont_v2_resultado d on d.fase = 'DEPOIS' and d.n = m.n_depois
                           and d.caso = m.caso_depois
 order by m.n_antes;

-- Falha fechado: o mapa tem de casar 1:1, senão o comparativo mente calado.
do $mapa$
declare v_n integer;
begin
  with mapa(n_antes, n_depois, caso_depois) as (values
    (1,  1, 'envio anterior classificado RESPOSTA, aluno respondeu ha 40h'),
    (2,  2, 'aluno respondeu ha 80h (fora da janela de 72h)'),
    (3,  3, 'operador NUNCA enviou nesta conversa'),
    (4,  4, 'operador ja enviou, aluno NUNCA respondeu'),
    (5, 11, 'op2 (nunca enviou) na MESMA conversa'),
    (6,  7, 'conversa ARQUIVADA')
  )
  select count(*) into v_n
    from mapa m
    join _cont_v2_resultado a on a.fase = 'ANTES'  and a.n = m.n_antes
    join _cont_v2_resultado d on d.fase = 'DEPOIS' and d.n = m.n_depois
                             and d.caso = m.caso_depois;
  if v_n <> 6 then
    raise exception 'comparativo pareou % linhas, esperado exatamente 6', v_n
      using errcode = '22023';
  end if;
  raise notice 'comparativo: 6 cenarios pareados 1:1';
end $mapa$;

do $final$
declare v_falhas integer; v_total integer;
begin
  select count(*) filter (where ok is not true), count(*)
    into v_falhas, v_total from _cont_v2_resultado;
  raise notice 'CONTINUIDADE v2: % assercoes, % falhas', v_total, v_falhas;
  if v_falhas > 0 then
    raise exception '% assercoes falharam', v_falhas using errcode = '22023';
  end if;
end $final$;
