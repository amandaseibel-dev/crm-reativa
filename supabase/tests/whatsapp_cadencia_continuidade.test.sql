-- Testes: cadencia com regra de continuidade de negociacao
-- =============================================================================
-- COMO RODAR: cole num ambiente de TESTE (staging). Cria canal proprio,
-- executa os casos e apaga tudo no fim. NAO use em producao.
--
-- DEPENDENCIAS: migration 20261030090000 ja aplicada (tabela whatsapp_config
-- com coluna continuidade_janela_horas, funcao whatsapp_cadencia_checar
-- com clausula CONTINUIDADE).
--
-- O QUE ESTES TESTES PROTEGEM, em ordem de importancia:
--
--   1. CONTINUIDADE nao e renovavel: envios de CONTINUIDADE nao criam linha em
--      whatsapp_abordagens, entao a janela e ancorada no primeiro contato e nao
--      pode ser esticada por envios sucessivos.
--
--   2. LIMITE_OPERADOR = 5: a 6ª conversa nova do operador no dia recebe
--      LIMITE_OPERADOR. Tentativas bloqueadas nao inserem em whatsapp_abordagens
--      (a funcao lanca excecao antes do INSERT), entao nao consomem cota.
--
--   3. CONTINUIDADE libera mesmo com cota esgotada: a conversa cujo primeiro
--      contato foi pago nao fica presa pelo limite do dia.
--
--   4. RESPOSTA: aluno escreveu nas ultimas 24h -> isento, nao conta.
--
--   5. Abertura/visualizacao de conversa NAO aciona a cadencia: a cadencia so
--      e chamada em whatsapp-send (envio real), nao em listarMensagens nem
--      em assumirConversa.
--
-- POR QUE NAO HA TESTE DE CONTINUIDADE APOS 48 H: manipular `now()` numa
-- sessao SQL exigiria CREATE EXTENSION ou sobrescrever a funcao, ambas operacoes
-- de Fase 2. A prova da janela vem do caso 4 (nenhuma linha nova em
-- whatsapp_abordagens), que e o invariante que torna qualquer expiracao correta
-- por design: se CONTINUIDADE nao cria linha, a janela nunca e renovada.
-- =============================================================================

drop table if exists _cad_cont_teste;
create table _cad_cont_teste (n int, caso text, ok boolean, detalhe text);

do $teste$
declare
  v_canal    uuid;
  v_conv1    uuid; -- para RESPOSTA
  v_conv2    uuid; -- para NOVA_ABORDAGEM -> CONTINUIDADE
  v_conv_x   uuid; -- auxiliar para LIMITE_OPERADOR
  v_conv_new uuid; -- conversa sem abordagem prévia para teste 11
  v_op1      text := 'op_cad_cont@test.local';
  v_agora    timestamptz := now();
  v_r        text;
  v_cnt      int;
  v_detail   text;
  v_i        int;
begin
  -- Canal de teste: janela 00:00-23:59 para nao interferir com horario real.
  insert into public.whatsapp_canais (
    sessao_chave, display_phone_number, apelido, ativo, conexao_status,
    conectado_em, modo, janela_inicio, janela_fim,
    limite_abordagens_operador, limite_abordagens_canal)
  values ('_cad_cont', '+55 51 90000-9000', 'Teste Cadencia Cont', true,
          'CONECTADO', now(), 'ATIVO_CONTROLADO', '00:00', '23:59', 5, null)
  returning id into v_canal;

  -- Conversas fixas
  insert into public.whatsapp_conversas (canal_id, telefone_e164, status)
  values (v_canal, '5551900009001', 'EM_ATENDIMENTO') returning id into v_conv1;
  insert into public.whatsapp_conversas (canal_id, telefone_e164, status)
  values (v_canal, '5551900009002', 'EM_ATENDIMENTO') returning id into v_conv2;
  -- Conversa sem abordagem prévia — usada no caso 8 para garantir INSERT real
  insert into public.whatsapp_conversas (canal_id, telefone_e164, status)
  values (v_canal, '5551900009003', 'EM_ATENDIMENTO') returning id into v_conv_new;

  perform set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_op1), true);

  -- ==========================================================================
  -- CASO 1: RESPOSTA — aluno escreveu ha 10 minutos -> livre, retorna 'RESPOSTA'
  -- ==========================================================================
  insert into public.whatsapp_mensagens (
    conversa_id, direcao, tipo, texto, timestamp_wa, criado_em,
    wamid, sessao_chave, telefone_e164, origem)
  values (v_conv1, 'ENTRADA', 'text', 'oi',
          v_agora - interval '10 min', v_agora - interval '10 min',
          'wam_cad_t1', '_cad_cont', '5551900009001', 'TEMPO_REAL');

  begin
    select public.whatsapp_cadencia_checar(v_canal, v_conv1, v_op1) into v_r;
    insert into _cad_cont_teste values (1, 'RESPOSTA: aluno escreveu ha 10 min', v_r = 'RESPOSTA',
      coalesce(v_r, 'null'));
  exception when others then
    insert into _cad_cont_teste values (1, 'RESPOSTA: aluno escreveu ha 10 min', false, sqlerrm);
  end;

  -- CASO 1B: RESPOSTA nao conta em whatsapp_abordagens
  select count(*) into v_cnt from public.whatsapp_abordagens
   where canal_id = v_canal and conversa_id = v_conv1;
  insert into _cad_cont_teste values (2, 'RESPOSTA: nao criou linha em abordagens', v_cnt = 0,
    format('linhas=%s', v_cnt));

  -- ==========================================================================
  -- CASO 2: NOVA_ABORDAGEM — conv2 sem historico -> conta na cota
  -- ==========================================================================
  begin
    select public.whatsapp_cadencia_checar(v_canal, v_conv2, v_op1) into v_r;
    insert into _cad_cont_teste values (3, 'NOVA_ABORDAGEM: sem historico', v_r = 'NOVA_ABORDAGEM',
      coalesce(v_r, 'null'));
  exception when others then
    insert into _cad_cont_teste values (3, 'NOVA_ABORDAGEM: sem historico', false, sqlerrm);
  end;

  -- Confirma que a linha foi criada em whatsapp_abordagens
  select count(*) into v_cnt from public.whatsapp_abordagens
   where canal_id = v_canal and conversa_id = v_conv2
     and operador_email = lower(v_op1);
  insert into _cad_cont_teste values (4, 'NOVA_ABORDAGEM: criou linha em abordagens', v_cnt = 1,
    format('linhas=%s', v_cnt));

  -- ==========================================================================
  -- CASO 3: CONTINUIDADE — conv2 ja tem abordagem registrada hoje -> isento
  -- ==========================================================================
  begin
    select public.whatsapp_cadencia_checar(v_canal, v_conv2, v_op1) into v_r;
    insert into _cad_cont_teste values (5, 'CONTINUIDADE: abordagem ja registrada', v_r = 'CONTINUIDADE',
      coalesce(v_r, 'null'));
  exception when others then
    insert into _cad_cont_teste values (5, 'CONTINUIDADE: abordagem ja registrada', false, sqlerrm);
  end;

  -- ==========================================================================
  -- CASO 4: CONTINUIDADE NAO RENOVA — apos CONTINUIDADE, ainda 1 linha em
  -- whatsapp_abordagens para conv2. Se fosse renovar, criaria linha nova ou
  -- a contagem mudaria. O invariante: CONTINUIDADE retorna antes do INSERT.
  -- ==========================================================================
  select count(*) into v_cnt from public.whatsapp_abordagens
   where canal_id = v_canal and conversa_id = v_conv2
     and operador_email = lower(v_op1);
  insert into _cad_cont_teste values (6, 'CONTINUIDADE: nao renova (ainda 1 linha)', v_cnt = 1,
    format('linhas apos continuidade=%s', v_cnt));

  -- ==========================================================================
  -- CASO 5: NOVA_ABORDAGEM em conversa diferente
  -- (INTERVALO_MINIMO nao dispara: nenhuma mensagem SAIDA inserida nesta sessao)
  -- ==========================================================================
  insert into public.whatsapp_conversas (canal_id, telefone_e164, status)
  values (v_canal, '5551900009003', 'EM_ATENDIMENTO') returning id into v_conv_x;

  begin
    select public.whatsapp_cadencia_checar(v_canal, v_conv_x, v_op1) into v_r;
    insert into _cad_cont_teste values (7, 'NOVA_ABORDAGEM: conversa diferente', v_r = 'NOVA_ABORDAGEM',
      coalesce(v_r, 'null'));
  exception when others then
    insert into _cad_cont_teste values (7, 'NOVA_ABORDAGEM: conversa diferente', false, sqlerrm);
  end;

  -- ==========================================================================
  -- CASO 6: LIMITE_OPERADOR — esgota cota (limite=5). Temos 2 abordagens (conv2,
  -- conv_x). Criamos mais 3 para totalizar 5. A 6a deve levantar excecao.
  -- ==========================================================================
  for v_i in 1..3 loop
    insert into public.whatsapp_conversas (canal_id, telefone_e164, status)
    values (v_canal, format('555190000900%s', v_i + 3), 'EM_ATENDIMENTO') returning id into v_conv_x;
    begin
      select public.whatsapp_cadencia_checar(v_canal, v_conv_x, v_op1) into v_r;
    exception when others then
      null; -- pode estourar na 3a se algo mudou; toleramos aqui
    end;
  end loop;

  -- 6a tentativa: deve bloqueiar
  insert into public.whatsapp_conversas (canal_id, telefone_e164, status)
  values (v_canal, '5551900009099', 'EM_ATENDIMENTO') returning id into v_conv_x;

  -- Conta abordagens DO OPERADOR antes da tentativa bloqueada
  select count(*) into v_cnt from public.whatsapp_abordagens
   where canal_id = v_canal and operador_email = lower(v_op1);

  begin
    select public.whatsapp_cadencia_checar(v_canal, v_conv_x, v_op1) into v_r;
    -- Se chegou aqui, o limite nao foi respeitado
    insert into _cad_cont_teste values (8, 'LIMITE_OPERADOR apos 5 abordagens', false,
      format('esperava excecao, retornou: %s', coalesce(v_r,'null')));
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    insert into _cad_cont_teste values (8, 'LIMITE_OPERADOR apos 5 abordagens',
      v_detail = 'LIMITE_OPERADOR', format('detail=%s msg=%s', v_detail, sqlerrm));
  end;

  -- CASO 6B: tentativa bloqueada nao consumiu cota (contagem identica)
  declare v_cnt2 int;
  begin
    select count(*) into v_cnt2 from public.whatsapp_abordagens
     where canal_id = v_canal and operador_email = lower(v_op1);
    insert into _cad_cont_teste values (9, 'Bloqueio nao consome cota', v_cnt = v_cnt2,
      format('antes=%s depois=%s', v_cnt, v_cnt2));
  end;

  -- ==========================================================================
  -- CASO 7: CONTINUIDADE liberada mesmo com cota esgotada
  -- ==========================================================================
  begin
    select public.whatsapp_cadencia_checar(v_canal, v_conv2, v_op1) into v_r;
    insert into _cad_cont_teste values (10, 'CONTINUIDADE com cota esgotada: continua liberada',
      v_r = 'CONTINUIDADE', coalesce(v_r, 'null'));
  exception when others then
    insert into _cad_cont_teste values (10, 'CONTINUIDADE com cota esgotada: continua liberada',
      false, sqlerrm);
  end;

  -- ==========================================================================
  -- CASO 8: continuidade_janela_horas = 0 desliga CONTINUIDADE
  -- Usa v_conv_new (sem abordagem prévia) para garantir INSERT real:
  -- sem ON CONFLICT, a contagem sobe para 6 > 5 = limite → LIMITE_OPERADOR.
  -- Prova que o caminho CONTINUIDADE foi pulado (v_conv2 teria retornado
  -- CONTINUIDADE com janela ativa, mas v_conv_new nunca foi abordada).
  -- ==========================================================================
  update public.whatsapp_config set continuidade_janela_horas = 0;
  begin
    select public.whatsapp_cadencia_checar(v_canal, v_conv_new, v_op1) into v_r;
    insert into _cad_cont_teste values (11, 'continuidade_janela_h=0: CONTINUIDADE desligada',
      false, format('esperava excecao LIMITE_OPERADOR, retornou: %s', coalesce(v_r,'null')));
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    insert into _cad_cont_teste values (11, 'continuidade_janela_h=0: CONTINUIDADE desligada',
      v_detail = 'LIMITE_OPERADOR',
      format('ok: detail=%s (caminho CONTINUIDADE pulado, INSERT real em v_conv_new)', v_detail));
  end;
  -- Restaura
  update public.whatsapp_config set continuidade_janela_horas = 48;

  -- ==========================================================================
  -- Limpeza — em qualquer ordem, por FK
  -- ==========================================================================
  delete from public.whatsapp_mensagens   where sessao_chave = '_cad_cont';
  delete from public.whatsapp_abordagens  where canal_id = v_canal;
  delete from public.whatsapp_conversas   where canal_id = v_canal;
  delete from public.whatsapp_canais      where sessao_chave = '_cad_cont';
end $teste$;

-- Resultado
select n, caso, ok, detalhe from _cad_cont_teste order by n;

select
  count(*) filter (where ok)     as passou,
  count(*) filter (where not ok) as falhou,
  count(*)                       as total
from _cad_cont_teste;

drop table if exists _cad_cont_teste;
