-- SANEAMENTO DAS 10 BAIXAS EXCEDENTES (DUPLICIDADE HISTORICA).
--
-- Fecha a parte historica da frente iniciada em 20260922290000, que impediu o
-- 12o caso. Aqui corrigimos 10 dos 11 registros que ja existiam.
--
-- O QUE FOI MEDIDO (auditoria somente leitura, 22/09/2026): 11 parcelas com
-- DUAS baixas vivas cada. R$ 34.138,60 registrados onde sao devidos
-- R$ 17.069,30. A parcela esta PAGO uma vez so -- o saldo do aluno nunca
-- esteve errado; o que conta dobrado e o valor baixado do periodo e os
-- honorarios recebidos (R$ 737,69 em duplicidade).
--
-- CLASSIFICACAO, caso a caso:
--   * 9 DUPLICIDADE TECNICA COMPROVADA -- valor, honorarios e responsavel
--     identicos nas duas linhas, com 3,4 a 7,7 segundos entre elas (o formulario
--     da ficha fechava antes da resposta e a operadora clicava de novo), mais o
--     caso de 2m31s do Murilo. Nos 5 casos que tem pagamento no arquivo
--     Santander existe EXATAMENTE UM recebimento -- e a prova financeira
--     independente de que nao houve dois pagamentos. O caso Gabriel e
--     conclusivo por si: 3 parcelas com timestamp identico ao milissegundo nas
--     duas rodadas, ou seja um lote de 3 disparado duas vezes.
--   * 1 SEGUNDA BAIXA INCORRETA POR ROTINA/SUFIXO -- Bianca Florence: a segunda
--     linha e da `rotina@sistema` ("Baixa pelo documento 50608170003") numa
--     parcela cujo boleto e ...0004, o deslocamento de sufixo ja documentado, e
--     com data_pagamento 03/08 contra o pagamento real de 03/09.
--
-- FORA DESTA MIGRATION, DE PROPOSITO: a 11a parcela
-- (e62006af-a61e-43eb-9729-367819c06e76, Maiara Ramos Machado, R$ 634,46) fica
-- INTOCADA. Sao 13 dias entre as duas baixas, nenhum pagamento registrado para
-- nenhuma delas e `prime_extrato` vazio: treze dias e compativel com dois
-- recebimentos reais, e nao se assume que a segunda esta errada so por ser a
-- mais recente. Continua com 2 baixas vivas, aguardando evidencia externa.
--
-- POR IDS EXATOS, NUNCA POR "MAIS RECENTE": a lista abaixo e literal e foi
-- congelada no preflight. Uma selecao dinamica por `order by baixado_em desc`
-- poderia pegar outra linha se algo mudasse entre a revisao e a aplicacao.
--
-- NAO FAZ: nenhum DELETE; nao toca em `parcelas` (todas seguem PAGO, nenhuma
-- divida reabre); nao toca em `alunos`, `acordos` ou `casos`; nao gera
-- CORRIGIR_COMPROVANTE; nao muda status operacional de ninguem; nenhum backfill.
--
-- POR QUE NAO `devolver_baixa_pagamento`: a RPC oficial faz muito mais do que
-- devolver a baixa -- ela reescreve a ficha do aluno
-- (status_atual/status_jornada/status_acionamento = 'BAIXA_DEVOLVIDA',
-- proxima_acao = 'CORRIGIR_COMPROVANTE', fila_destino = 'OPERADOR_ORIGEM') e
-- notifica o operador de origem. Nos 10 alvos isso destruiria estados
-- operacionais vivos (ACORDO_FECHADO com lembrete marcado, "E-mail enviado -
-- Acordo quebrado", MENSAGEM_ENVIADA, QUITADO) e reescreveria a ficha do
-- Gabriel tres vezes. Aqui a intervencao e cirurgica: so os 4 campos da propria
-- baixa.
--
-- DOIS GATILHOS PRECISAM FICAR FORA, E SO DURANTE ESTA TRANSACAO:
--
--   1. `trg_notif_divergencia_cartao` dispara em AFTER UPDATE OF devolvido_em e
--      manda "Divergencia de cartao -- a baixa de cartao de X voltou para voce,
--      revise e reenvie" para `responsavel_baixa_email`. Nao e divergencia de
--      cartao e nao ha nada para a operadora revisar: cobranca03, cobranca05,
--      cobranca06 e cobranca13 receberiam um aviso falso, mais 5 linhas para
--      `importacao@sistema`.
--
--   2. `trg_recalc_baixa` chama `recalcular_situacao_aluno`, que NAO le
--      `baixas_pagamento` -- ela recalcula de parcelas/acordos, que aqui nao
--      mudam, entao gravaria exatamente os mesmos valores. So que gravaria em
--      `public.alunos`, que tem 17 gatilhos proprios (sync de casos, de
--      responsavel, de acionamento). Escrever em `alunos` e justamente o que
--      esta proibido nesta intervencao.
--
-- DESABILITAR AQUI NAO ABRE JANELA PARA NINGUEM: `ALTER TABLE ... DISABLE
-- TRIGGER` pega ACCESS EXCLUSIVE na tabela, entao enquanto eles estao
-- desligados nenhuma outra sessao consegue sequer escrever em
-- `baixas_pagamento` -- nao existe insercao de terceiro que escape do gatilho.
-- E tudo e uma transacao so: se qualquer checagem falhar, o ALTER volta junto e
-- os gatilhos continuam ligados. O bloco final confere que os dois terminaram
-- habilitados e aborta se nao tiverem terminado.
--
-- Os outros dois gatilhos da tabela seguem ATIVOS de proposito:
-- `trg_baixa_viva_unica_por_parcela` (so BEFORE INSERT, nem e alcancado por
-- UPDATE) e `trg_bloquear_baixa_acordo_encerrado`, que nao barra nada aqui
-- porque so levanta excecao quando `status_baixa = 'REALIZADA'` -- e estamos
-- gravando 'BAIXA_DEVOLVIDA'.

do $saneamento$
declare
  v_alvos int;
  v_ok    int;
  v_lig   int;
  r       record;
begin
  -- ---------------------------------------------------------------------
  -- 1) A LISTA LITERAL. cada par: a baixa que FICA e a que sai.
  -- ---------------------------------------------------------------------
  create temporary table _san_alvo (
    baixa_devolver uuid primary key,
    baixa_fica     uuid not null,
    parcela_id     uuid not null,
    quem           text not null,
    motivo_extra   text
  ) on commit drop;

  insert into _san_alvo (baixa_devolver, baixa_fica, parcela_id, quem, motivo_extra) values
   ('41fcfcd6-8e6d-4636-884e-694b62b0a46b','67f3e82a-0357-4d26-a822-50d948c2f716','f41f03d3-e260-41d4-8299-bdba04ed5a17','Murilo Montemezzo', null),
   ('bd2fe50e-b2e2-49a5-bf71-836dac3ccd12','e967c28d-3855-408d-949a-e4fc14ae1d98','42319df4-06ae-43cb-9b68-3473a74fb63b','Pablo Juan Werlang', null),
   ('f18fc685-8ba8-4254-ab48-f65b59505af8','7d3a56fd-8b81-4deb-bf41-e05abd56adcf','2ad09a00-101a-4431-8a74-9f3013b26b1a','Bianca de Oliveira Michielin', null),
   ('b7b336d1-8cc5-4114-90ac-0e958ad05560','69c30813-7080-4d37-8a35-7532af67ce58','84f8349f-eecb-4ea1-8d3d-6a4474a91f83','Enzo Enrique Alves Borges', null),
   ('9953927f-c80e-45e1-9e85-117b6a4d0fe6','6f9009a7-d7d7-43d1-8971-94e3f33889e7','4590c339-b5b8-4e71-9d99-48d67f9bf26f','Gabriel Gomes Oliveira (parcela 3)', null),
   ('3d9cf264-c8de-43cc-af57-7424f6cfca1c','7544fc96-864b-4a31-8437-c6b6b7bd968b','2e01f8a2-e384-4ff8-acce-f13a2b3bb9fd','Gabriel Gomes Oliveira (parcela 2)', null),
   ('80832d6f-b09c-40ab-9140-1e220dc1bfd6','a83d863c-c149-47e0-b3bc-6148e5434b51','15ea01b8-cb55-4aa6-b7bd-90234831f3e7','Gabriel Gomes Oliveira (parcela 4)', null),
   ('ec2fb7c7-5dc4-43e2-be88-00db70557018','94bacbc9-3db3-46a0-8a71-f9ca59196c81','d1cc1b6a-b4d9-4690-8e4f-996eb0e8dc60','Lanna Caroline Braga dos Santos', null),
   ('4f84aff9-a590-4f21-b572-90e11857c664','ce426d07-0807-4795-ad37-2fa4d52fedca','c0f1d10f-c563-4be4-84ea-69b3a573d74f','Bruna Ohana de Oliveira Goulart', null),
   ('c5a391ec-3f1d-4e65-b6bf-16e67f8e8cb1','935ed174-0ed5-45c9-8759-80d3f0a41606','365a7b42-26b5-40b5-b7d6-59c4a5645bc5','Bianca Florence da Silva',
    ' Gerada pela rotina de baixa pelo documento citando o documento 50608170003, incompativel com o boleto 50608170004 desta parcela (deslocamento de sufixo), e com data_pagamento 03/08 contra o pagamento real de 03/09.');

  select count(*) into v_alvos from _san_alvo;
  if v_alvos <> 10 then
    raise exception 'SANEAMENTO ABORTADO: a lista tem % alvos, esperados 10.', v_alvos;
  end if;

  -- ---------------------------------------------------------------------
  -- 2) GUARDAS. Qualquer divergencia com o preflight aborta tudo.
  -- ---------------------------------------------------------------------
  -- a Maiara nao pode estar na lista, por nenhum caminho
  if exists (select 1 from _san_alvo where parcela_id = 'e62006af-a61e-43eb-9729-367819c06e76') then
    raise exception 'SANEAMENTO ABORTADO: a parcela da Maiara esta na lista de alvos.';
  end if;

  -- toda baixa a devolver existe, esta VIVA e REALIZADA, e e da parcela declarada
  select count(*) into v_ok
    from _san_alvo a join public.baixas_pagamento b on b.id = a.baixa_devolver
   where b.devolvido_em is null
     and coalesce(b.status_baixa,'') = 'REALIZADA'
     and b.parcela_id = a.parcela_id;
  if v_ok <> 10 then
    raise exception 'SANEAMENTO ABORTADO: so % das 10 baixas a devolver conferem (viva, REALIZADA e na parcela declarada).', v_ok;
  end if;

  -- a baixa que FICA existe, esta viva, e a parcela fica com exatamente 2 vivas hoje
  select count(*) into v_ok
    from _san_alvo a join public.baixas_pagamento b on b.id = a.baixa_fica
   where b.devolvido_em is null and b.parcela_id = a.parcela_id;
  if v_ok <> 10 then
    raise exception 'SANEAMENTO ABORTADO: so % das 10 baixas que devem PERMANECER conferem.', v_ok;
  end if;

  for r in select a.parcela_id, a.quem,
                  (select count(*) from public.baixas_pagamento b
                    where b.parcela_id = a.parcela_id and b.devolvido_em is null) n
             from _san_alvo a
  loop
    if r.n <> 2 then
      raise exception 'SANEAMENTO ABORTADO: a parcela de % tem % baixas vivas, esperadas 2.', r.quem, r.n;
    end if;
  end loop;

  -- ---------------------------------------------------------------------
  -- 3) Os dois gatilhos saem de cena -- so dentro desta transacao.
  -- ---------------------------------------------------------------------
  alter table public.baixas_pagamento disable trigger trg_notif_divergencia_cartao;
  alter table public.baixas_pagamento disable trigger trg_recalc_baixa;

  -- ---------------------------------------------------------------------
  -- 4) O saneamento: 4 campos, nas 10 linhas, por id exato.
  -- ---------------------------------------------------------------------
  update public.baixas_pagamento b
     set devolvido_em       = now(),
         status_baixa       = 'BAIXA_DEVOLVIDA',
         devolvido_por_email = 'saneamento@sistema',
         motivo_devolucao   = 'SANEAMENTO_DUPLICIDADE_HISTORICA_20260922: segunda baixa viva na mesma parcela, sem segundo pagamento correspondente. A baixa que permanece e ' || a.baixa_fica::text || '.' || coalesce(a.motivo_extra, '')
    from _san_alvo a
   where b.id = a.baixa_devolver;

  get diagnostics v_ok = row_count;
  if v_ok <> 10 then
    raise exception 'SANEAMENTO ABORTADO: o update alcancou % linhas, esperadas 10.', v_ok;
  end if;

  -- ---------------------------------------------------------------------
  -- 5) Os gatilhos voltam ANTES do commit.
  -- ---------------------------------------------------------------------
  alter table public.baixas_pagamento enable trigger trg_notif_divergencia_cartao;
  alter table public.baixas_pagamento enable trigger trg_recalc_baixa;

  select count(*) into v_lig
    from pg_trigger
   where tgrelid = 'public.baixas_pagamento'::regclass
     and tgname in ('trg_notif_divergencia_cartao','trg_recalc_baixa')
     and tgenabled = 'O';
  if v_lig <> 2 then
    raise exception 'SANEAMENTO ABORTADO: % de 2 gatilhos religados.', v_lig;
  end if;

  -- nenhum outro gatilho da tabela pode ter ficado desabilitado
  select count(*) into v_lig
    from pg_trigger
   where tgrelid = 'public.baixas_pagamento'::regclass
     and not tgisinternal and tgenabled <> 'O';
  if v_lig <> 0 then
    raise exception 'SANEAMENTO ABORTADO: % gatilho(s) da tabela ficaram desabilitados.', v_lig;
  end if;

  -- ---------------------------------------------------------------------
  -- 6) Resultado: cada parcela saneada fica com exatamente 1 viva; a Maiara,
  --    com 2. Se nao for isso, a transacao inteira volta.
  -- ---------------------------------------------------------------------
  for r in select a.parcela_id, a.quem,
                  (select count(*) from public.baixas_pagamento b
                    where b.parcela_id = a.parcela_id and b.devolvido_em is null) n
             from _san_alvo a
  loop
    if r.n <> 1 then
      raise exception 'SANEAMENTO ABORTADO: apos o saneamento a parcela de % ficou com % baixas vivas, esperada 1.', r.quem, r.n;
    end if;
  end loop;

  select count(*) into v_ok
    from public.baixas_pagamento
   where parcela_id = 'e62006af-a61e-43eb-9729-367819c06e76' and devolvido_em is null;
  if v_ok <> 2 then
    raise exception 'SANEAMENTO ABORTADO: a parcela da Maiara ficou com % baixas vivas, esperadas 2 (intocada).', v_ok;
  end if;

  select count(*) into v_ok from (
    select b.parcela_id from public.baixas_pagamento b
     where b.devolvido_em is null and b.parcela_id is not null
     group by b.parcela_id having count(*) > 1) x;
  if v_ok <> 1 then
    raise exception 'SANEAMENTO ABORTADO: sobraram % parcelas com duplicidade, esperada 1 (a da Maiara).', v_ok;
  end if;

  raise notice 'SANEAMENTO OK: 10 baixas devolvidas, 1 duplicidade remanescente (Maiara, aguardando evidencia).';
end;
$saneamento$;
