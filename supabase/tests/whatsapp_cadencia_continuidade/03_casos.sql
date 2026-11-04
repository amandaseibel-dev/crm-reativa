-- CASOS — 11 cenários para whatsapp_cadencia_checar com CONTINUIDADE.
--
-- Pré-condição: 01_ambiente.sql + 02_baseline.sql + migration 20261030090000 aplicados.
-- Canal de teste usa janela 00:00-23:59 para não depender do horário de execução.
-- Limite operador=5 (estado pós-migration).
--
-- CORREÇÃO vs test.sql original: caso 5 usa telefone '5551900009007' para
-- v_conv_x, evitando conflito com v_conv_new ('5551900009003') no
-- UNIQUE (canal_id, telefone_e164).

\set ON_ERROR_STOP on

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
  -- Canal de teste: janela 00:00-23:59 para não interferir com horário real.
  insert into public.whatsapp_canais (
    sessao_chave, display_phone_number, apelido, ativo, conexao_status,
    modo, janela_inicio, janela_fim,
    limite_abordagens_operador, limite_abordagens_canal)
  values ('_cad_cont', '+55 51 90000-9000', 'Teste Cadencia Cont', true,
          'CONECTADO', 'ATIVO_CONTROLADO', '00:00', '23:59', 5, null)
  returning id into v_canal;

  -- Conversas fixas
  insert into public.whatsapp_conversas (canal_id, telefone_e164, status)
  values (v_canal, '5551900009001', 'EM_ATENDIMENTO') returning id into v_conv1;
  insert into public.whatsapp_conversas (canal_id, telefone_e164, status)
  values (v_canal, '5551900009002', 'EM_ATENDIMENTO') returning id into v_conv2;
  -- v_conv_new: sem abordagem prévia — usada no caso 8 para garantir INSERT real
  insert into public.whatsapp_conversas (canal_id, telefone_e164, status)
  values (v_canal, '5551900009003', 'EM_ATENDIMENTO') returning id into v_conv_new;

  perform set_config('request.jwt.claims',
    format('{"email":"%s","role":"authenticated"}', v_op1), true);

  -- ========================================================================
  -- CASO 1: RESPOSTA — aluno escreveu há 10 minutos -> livre, retorna 'RESPOSTA'
  -- ========================================================================
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

  -- CASO 1B: RESPOSTA não conta em whatsapp_abordagens
  select count(*) into v_cnt from public.whatsapp_abordagens
   where canal_id = v_canal and conversa_id = v_conv1;
  insert into _cad_cont_teste values (2, 'RESPOSTA: nao criou linha em abordagens', v_cnt = 0,
    format('linhas=%s', v_cnt));

  -- ========================================================================
  -- CASO 2: NOVA_ABORDAGEM — conv2 sem histórico -> conta na cota
  -- ========================================================================
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

  -- ========================================================================
  -- CASO 3: CONTINUIDADE — conv2 já tem abordagem registrada hoje -> isento
  -- ========================================================================
  begin
    select public.whatsapp_cadencia_checar(v_canal, v_conv2, v_op1) into v_r;
    insert into _cad_cont_teste values (5, 'CONTINUIDADE: abordagem ja registrada', v_r = 'CONTINUIDADE',
      coalesce(v_r, 'null'));
  exception when others then
    insert into _cad_cont_teste values (5, 'CONTINUIDADE: abordagem ja registrada', false, sqlerrm);
  end;

  -- ========================================================================
  -- CASO 4: CONTINUIDADE NÃO RENOVA — após CONTINUIDADE, ainda 1 linha em
  -- whatsapp_abordagens para conv2.
  -- ========================================================================
  select count(*) into v_cnt from public.whatsapp_abordagens
   where canal_id = v_canal and conversa_id = v_conv2
     and operador_email = lower(v_op1);
  insert into _cad_cont_teste values (6, 'CONTINUIDADE: nao renova (ainda 1 linha)', v_cnt = 1,
    format('linhas apos continuidade=%s', v_cnt));

  -- ========================================================================
  -- CASO 5: NOVA_ABORDAGEM em conversa diferente
  -- v_conv_x usa telefone 5551900009007 (diferente de v_conv_new: 5551900009003)
  -- ========================================================================
  insert into public.whatsapp_conversas (canal_id, telefone_e164, status)
  values (v_canal, '5551900009007', 'EM_ATENDIMENTO') returning id into v_conv_x;

  begin
    select public.whatsapp_cadencia_checar(v_canal, v_conv_x, v_op1) into v_r;
    insert into _cad_cont_teste values (7, 'NOVA_ABORDAGEM: conversa diferente', v_r = 'NOVA_ABORDAGEM',
      coalesce(v_r, 'null'));
  exception when others then
    insert into _cad_cont_teste values (7, 'NOVA_ABORDAGEM: conversa diferente', false, sqlerrm);
  end;

  -- ========================================================================
  -- CASO 6: LIMITE_OPERADOR — esgota cota (limite=5). Temos 2 abordagens
  -- (conv2, conv_x). Criamos mais 3 para totalizar 5. A 6ª deve lançar exceção.
  -- ========================================================================
  for v_i in 1..3 loop
    insert into public.whatsapp_conversas (canal_id, telefone_e164, status)
    values (v_canal, format('555190000900%s', v_i + 3), 'EM_ATENDIMENTO') returning id into v_conv_x;
    begin
      select public.whatsapp_cadencia_checar(v_canal, v_conv_x, v_op1) into v_r;
    exception when others then
      null;
    end;
  end loop;

  -- 6ª tentativa: deve bloquear
  insert into public.whatsapp_conversas (canal_id, telefone_e164, status)
  values (v_canal, '5551900009099', 'EM_ATENDIMENTO') returning id into v_conv_x;

  select count(*) into v_cnt from public.whatsapp_abordagens
   where canal_id = v_canal and operador_email = lower(v_op1);

  begin
    select public.whatsapp_cadencia_checar(v_canal, v_conv_x, v_op1) into v_r;
    insert into _cad_cont_teste values (8, 'LIMITE_OPERADOR apos 5 abordagens', false,
      format('esperava excecao, retornou: %s', coalesce(v_r,'null')));
  exception when others then
    get stacked diagnostics v_detail = pg_exception_detail;
    insert into _cad_cont_teste values (8, 'LIMITE_OPERADOR apos 5 abordagens',
      v_detail = 'LIMITE_OPERADOR', format('detail=%s msg=%s', v_detail, sqlerrm));
  end;

  -- CASO 6B: tentativa bloqueada não consumiu cota (contagem idêntica)
  declare v_cnt2 int;
  begin
    select count(*) into v_cnt2 from public.whatsapp_abordagens
     where canal_id = v_canal and operador_email = lower(v_op1);
    insert into _cad_cont_teste values (9, 'Bloqueio nao consome cota', v_cnt = v_cnt2,
      format('antes=%s depois=%s', v_cnt, v_cnt2));
  end;

  -- ========================================================================
  -- CASO 7: CONTINUIDADE liberada mesmo com cota esgotada
  -- ========================================================================
  begin
    select public.whatsapp_cadencia_checar(v_canal, v_conv2, v_op1) into v_r;
    insert into _cad_cont_teste values (10, 'CONTINUIDADE com cota esgotada: continua liberada',
      v_r = 'CONTINUIDADE', coalesce(v_r, 'null'));
  exception when others then
    insert into _cad_cont_teste values (10, 'CONTINUIDADE com cota esgotada: continua liberada',
      false, sqlerrm);
  end;

  -- ========================================================================
  -- CASO 8: continuidade_janela_horas = 0 desliga CONTINUIDADE
  -- Usa v_conv_new (telefone 5551900009003, sem abordagem prévia) para garantir
  -- INSERT real: sem ON CONFLICT, a contagem sobe para 6 > 5 = limite → LIMITE_OPERADOR.
  -- ========================================================================
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

  -- ========================================================================
  -- Limpeza — em qualquer ordem, por FK
  -- ========================================================================
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

-- Falha o job se qualquer caso não passou
do $$
declare v_falhou int;
begin
  select count(*) filter (where not ok) into v_falhou from _cad_cont_teste;
  if v_falhou > 0 then
    raise exception '% caso(s) falhou(aram) — ver resultado acima', v_falhou;
  end if;
end $$;

drop table if exists _cad_cont_teste;
