-- CASOS — COTA 10 ATIVA + RECEPTIVO NA FILA (20261111150000)
--
-- Pré-condição: ambiente da v2 + migration v2 + 01_ambiente_cota.sql +
-- migration da cota 10, nesta ordem.
--
-- Cada passo é um STATEMENT PRÓPRIO (autocommit), como em produção:
-- assumir, preparar, enviar e registrar são transações diferentes, e o
-- ciclo de responsabilidade depende de now() mudar entre elas.
-- Janela 00:00-23:59 nos canais de teste; idades relativas, nunca data
-- absoluta.
--
-- MAPA DO PEDIDO -> CASOS
--   COTA = só abordagem ATIVA
--     limite 10 por operador ............................ A1-A5
--     gerência/supervisão/administrativo sem limite ..... B1-B6
--     gestão barrada pelo teto do canal e pelo 60s ...... C1, C2
--     resposta e continuidade não gastam ................ D1-D4
--     responder não altera a cota ATIVA ................. S1-S3
--   RECEPTIVO = fila
--     assumir não conta ................................. R1
--     FALHOU não conta .................................. R2
--     1a resposta ENVIADA conta 1 e move a fila ......... R3, R3b
--     reenvio do mesmo wamid = 1 ........................ R4
--     segunda resposta = 1 .............................. R5
--     responder não gasta cota .......................... R6
--     troca de responsável = ciclo novo, conta p/ novo .. R7a, R7b
--     envio de quem não é o responsável ................. R8
--     conversa aberta por abordagem ativa ............... R9a, R9b
--     operador fora da fila ............................. R10
--     ciclo já atendido antes da publicação ............. R11
--     SYNC_INICIAL ...................................... R12
--     falha aberto ...................................... R13
--     RPC antiga + trigger no mesmo ciclo = 1 ........... R14
--     botão "Marcar" (MANUAL) preservado ................ R15
--     duas respostas simultâneas = 1 .................... job do CI (04)
--   tela / grants / proteções ........................... F1-F7, H1-H9, I1-I5

\set ON_ERROR_STOP on

select public._t_canal('_cota10', 'ATIVO_CONTROLADO', 10, null) as c10 \gset
select public._t_canal('_cota_teto', 'ATIVO_CONTROLADO', 10, 3) as cteto \gset

-- Membros da fila do receptivo
insert into public.fila_receptivo (email, nome, atendimentos_hoje, data_referencia)
select e, e, 0, (now() at time zone 'America/Sao_Paulo')::date
  from unnest(array['op_e@test.local', 'op_f@test.local', 'op_g@test.local',
                    'op_c@test.local', 'op_b@test.local', 'sup_cota@test.local']) e;

-- ============================ A. limite 10 ================================
insert into _cota_r
select 'A1', '10 abordagens ativas do operador passam', '10',
       count(*) filter (where r = 'NOVA_ABORDAGEM')::text
  from (select public._t_checar(:'c10',
                 public._t_conversa(:'c10', '55519100000' || lpad(g::text, 2, '0')),
                 'op_a@test.local') r
          from generate_series(1, 10) g) x;

insert into _cota_r values ('A2', '11a abordagem ativa e barrada', 'LIMITE_OPERADOR',
  public._t_checar(:'c10', public._t_conversa(:'c10', '5551910000011'), 'op_a@test.local'));

select id as a_conv1 from public.whatsapp_conversas where telefone_e164 = '5551910000001' \gset

insert into _cota_r values ('A3', 'mesma pessoa de novo no dia nao conta de novo (no limite)', 'NOVA_ABORDAGEM',
  public._t_checar(:'c10', :'a_conv1', 'op_a@test.local'));

insert into _cota_r values ('A4', 'cota usada continua 10 (barrada e repetida nao somam)', '10',
  public._t_cota(:'c10', 'op_a@test.local')::text);

insert into public.whatsapp_cadencia_liberacoes (canal_id, operador_email, dia, extra, concedido_por, motivo)
values (:'c10', 'op_a@test.local', (now() at time zone 'America/Sao_Paulo')::date, 1, 'teste', 'teste');

insert into _cota_r values ('A5', 'liberacao extra do dia segue somando ao limite (11a passa)', 'NOVA_ABORDAGEM',
  public._t_checar(:'c10', (select id from public.whatsapp_conversas where telefone_e164 = '5551910000011'),
                   'op_a@test.local'));

-- ===================== B. perfis sem limite individual ====================
insert into _cota_r
select 'B' || p.n, p.email || ': 12 abordagens ativas passam', '12',
       (select count(*) filter (where r = 'NOVA_ABORDAGEM')
          from (select public._t_checar(:'c10',
                         public._t_conversa(:'c10', '5551920' || p.n || lpad(g::text, 5, '0')),
                         p.email) r
                  from generate_series(1, 12) g) x)::text
  from (values (1, 'ger_cota@test.local'), (2, 'sup_cota@test.local'), (3, 'adm_cota@test.local')) p(n, email);

insert into _cota_r
select 'B4', 'diretoria (fora da lista) segue com limite: 11a barrada', '10|LIMITE_OPERADOR',
       (select count(*) filter (where r = 'NOVA_ABORDAGEM')
          from (select public._t_checar(:'c10',
                         public._t_conversa(:'c10', '55519240' || lpad(g::text, 5, '0')),
                         'dir_cota@test.local') r
                  from generate_series(1, 10) g) x)::text
       || '|' || public._t_checar(:'c10', public._t_conversa(:'c10', '5551924099999'), 'dir_cota@test.local');

insert into _cota_r
select 'B5', 'gerencia INATIVA nao herda isencao: 11a barrada', '10|LIMITE_OPERADOR',
       (select count(*) filter (where r = 'NOVA_ABORDAGEM')
          from (select public._t_checar(:'c10',
                         public._t_conversa(:'c10', '55519250' || lpad(g::text, 5, '0')),
                         'ger_inativo@test.local') r
                  from generate_series(1, 10) g) x)::text
       || '|' || public._t_checar(:'c10', public._t_conversa(:'c10', '5551925099999'), 'ger_inativo@test.local');

insert into _cota_r values ('B6', 'abordagem da gestao segue gravada (para o teto do canal)', '12',
  (select count(*)::text from public.whatsapp_abordagens
    where canal_id = :'c10' and operador_email = 'ger_cota@test.local'));

-- ============== C. gestão: teto do canal e intervalo de 60s ================
insert into _cota_r
select 'C1', 'gestao sem limite individual e barrada pelo teto do canal (3)', '3|LIMITE_CANAL',
       (select count(*) filter (where r = 'NOVA_ABORDAGEM')
          from (select public._t_checar(:'cteto',
                         public._t_conversa(:'cteto', '55519300' || lpad(g::text, 5, '0')),
                         'ger_cota@test.local') r
                  from generate_series(1, 3) g) x)::text
       || '|' || public._t_checar(:'cteto', public._t_conversa(:'cteto', '5551930099999'), 'ger_cota@test.local');

select public._t_conversa(:'c10', '5551960000001') as c2a,
       public._t_conversa(:'c10', '5551960000002') as c2b \gset
select public._t_assumir(:'c2a', 'ger_cota@test.local', 5);
select public._t_registrar(:'c2a', 'ger_cota@test.local', 'ENVIADO', 'w-c2-1', 0);
insert into _cota_r values ('C2', 'gestao e barrada pelo intervalo de 60s', 'INTERVALO_MINIMO',
  public._t_checar(:'c10', :'c2b', 'ger_cota@test.local'));

-- ============== D. resposta e continuidade não gastam cota =================
select public._t_conversa(:'c10', '5551940000001') as d1,
       public._t_conversa(:'c10', '5551940000002') as d2,
       public._t_conversa(:'c10', '5551940000003') as d3,
       public._t_conversa(:'c10', '5551940000004') as d4 \gset
select public._t_msg(:'d1', 'ENTRADA', 2);
select public._t_msg(:'d2', 'ENTRADA', 48), public._t_msg(:'d2', 'SAIDA', 46, 'op_d@test.local'),
       public._t_msg(:'d2', 'ENTRADA', 40);

insert into _cota_r values ('D1', 'RESPOSTA (aluno escreveu ha 2h) nao gasta cota', 'RESPOSTA|0',
  public._t_checar(:'c10', :'d1', 'op_d@test.local') || '|' || public._t_cota(:'c10', 'op_d@test.local'));
insert into _cota_r values ('D2', 'CONTINUIDADE v2 preservada e nao gasta cota', 'CONTINUIDADE|0',
  public._t_checar(:'c10', :'d2', 'op_d@test.local') || '|' || public._t_cota(:'c10', 'op_d@test.local'));

select count(*) from (select public._t_checar(:'c10',
         public._t_conversa(:'c10', '55519410' || lpad(g::text, 5, '0')), 'op_d@test.local')
         from generate_series(1, 10) g) x;

select public._t_msg(:'d3', 'ENTRADA', 1);
select public._t_msg(:'d4', 'ENTRADA', 30), public._t_msg(:'d4', 'SAIDA', 29, 'op_d@test.local'),
       public._t_msg(:'d4', 'ENTRADA', 28);
insert into _cota_r values ('D3', 'operador com 10 usadas ainda RESPONDE', 'RESPOSTA|10',
  public._t_checar(:'c10', :'d3', 'op_d@test.local') || '|' || public._t_cota(:'c10', 'op_d@test.local'));
insert into _cota_r values ('D4', 'operador com 10 usadas ainda faz CONTINUIDADE', 'CONTINUIDADE|10',
  public._t_checar(:'c10', :'d4', 'op_d@test.local') || '|' || public._t_cota(:'c10', 'op_d@test.local'));

-- ======================== R. receptivo = fila ==============================
select public._t_conversa(:'c10', '5551950000001') as r1 \gset
select public._t_msg(:'r1', 'ENTRADA', 1);

select public._t_assumir(:'r1', 'op_e@test.local', 600);
insert into _cota_r values ('R1', 'ASSUMIR nao conta atendimento', '0|0',
  public._t_log('op_e@test.local') || '|' || public._t_fila('op_e@test.local'));

select public._t_registrar(:'r1', 'op_e@test.local', 'FALHOU', 'falha:r1:1', 500);
insert into _cota_r values ('R2', 'envio FALHOU nao conta', '0|0',
  public._t_log('op_e@test.local') || '|' || public._t_fila('op_e@test.local'));

select public._t_registrar(:'r1', 'op_e@test.local', 'ENVIADO', 'w-r1-1', 400);
insert into _cota_r values ('R3', '1a resposta ENVIADA conta 1 atendimento e move a fila', '1|1|true',
  public._t_log('op_e@test.local') || '|' || public._t_fila('op_e@test.local') || '|' ||
  (select (ultimo_atendimento is not null)::text from public.fila_receptivo where email = 'op_e@test.local'));
insert into _cota_r values ('R3b', 'o log guarda o ciclo (responsavel_desde) da conversa', 'true',
  (select (l.responsavel_desde = cv.responsavel_desde)::text
     from public.receptivo_atendimentos_log l, public.whatsapp_conversas cv
    where l.operador_email = 'op_e@test.local' and l.fonte = 'WHATSAPP' and cv.id = :'r1'));

select public._t_registrar(:'r1', 'op_e@test.local', 'ENVIADO', 'w-r1-1', 400);
insert into _cota_r values ('R4', 'reenvio do MESMO wamid nao conta de novo', '1|1',
  public._t_log('op_e@test.local') || '|' || public._t_fila('op_e@test.local'));

select public._t_msg(:'r1', 'ENTRADA', 0.09);
select public._t_registrar(:'r1', 'op_e@test.local', 'ENVIADO', 'w-r1-2', 300);
insert into _cota_r values ('R5', 'segunda resposta no MESMO ciclo nao conta de novo', '1|1',
  public._t_log('op_e@test.local') || '|' || public._t_fila('op_e@test.local'));

insert into _cota_r values ('R6', 'responder no receptivo nao gasta cota ATIVA', '0',
  public._t_cota(:'c10', 'op_e@test.local')::text);

-- troca de responsável (transferência) = ciclo novo para quem recebe
select public._t_msg(:'r1', 'ENTRADA', 0.07);
select public._t_assumir(:'r1', 'op_f@test.local', 250);
insert into _cota_r values ('R7a', 'TROCA: receber a conversa nao conta', '0|0',
  public._t_log('op_f@test.local') || '|' || public._t_fila('op_f@test.local'));
select public._t_registrar(:'r1', 'op_f@test.local', 'ENVIADO', 'w-r1-3', 200);
insert into _cota_r values ('R7b', 'TROCA: 1a resposta do novo responsavel conta para ele; o anterior segue 1', '1|1|1',
  public._t_log('op_f@test.local') || '|' || public._t_fila('op_f@test.local') || '|' ||
  public._t_fila('op_e@test.local'));

-- envio de quem não é o responsável (gestão respondendo conversa do operador)
select public._t_msg(:'r1', 'ENTRADA', 0.04);
select public._t_registrar(:'r1', 'sup_cota@test.local', 'ENVIADO', 'w-r1-4', 100);
insert into _cota_r values ('R8', 'envio de quem NAO e o responsavel nao conta para ninguem', '0|1',
  public._t_fila('sup_cota@test.local') || '|' || public._t_fila('op_f@test.local'));

-- conversa aberta por abordagem ativa não é receptivo
select public._t_conversa(:'c10', '5551950000009') as r9 \gset
insert into _cota_r values ('R9a', 'operador inicia conversa (preparar_envio)', 'NOVA_ABORDAGEM',
  public._t_preparar(:'c10', :'r9', 'op_c@test.local'));
select public._t_registrar(:'r9', 'op_c@test.local', 'ENVIADO', 'w-r9-1');
insert into _cota_r values ('R9b', 'abordagem ativa: conta na cota (1), nao na fila (0)', '1|0',
  public._t_cota(:'c10', 'op_c@test.local') || '|' || public._t_fila('op_c@test.local'));

-- operador fora da fila: nada a contar, mensagem registrada
select public._t_conversa(:'c10', '5551950000010') as r10 \gset
select public._t_msg(:'r10', 'ENTRADA', 1);
select public._t_assumir(:'r10', 'op_a@test.local', 600);
select public._t_registrar(:'r10', 'op_a@test.local', 'ENVIADO', 'w-r10-1', 300);
insert into _cota_r values ('R10', 'operador fora da fila: sem log, mensagem registrada', '0|1',
  public._t_log('op_a@test.local') || '|' ||
  (select count(*)::text from public.whatsapp_mensagens where wamid = 'w-r10-1'));

-- ciclo antigo: operador já tinha respondido nele antes da publicação
select public._t_conversa(:'c10', '5551950000011') as r11 \gset
select public._t_msg(:'r11', 'ENTRADA', 2);
select public._t_assumir(:'r11', 'op_g@test.local', 7200);
alter table public.whatsapp_mensagens disable trigger trg_whatsapp_a0_receptivo_atendimento;
select public._t_registrar(:'r11', 'op_g@test.local', 'ENVIADO', 'w-r11-legado', 3600);
alter table public.whatsapp_mensagens enable trigger trg_whatsapp_a0_receptivo_atendimento;
select public._t_msg(:'r11', 'ENTRADA', 0.5);
select public._t_registrar(:'r11', 'op_g@test.local', 'ENVIADO', 'w-r11-1', 120);
insert into _cota_r values ('R11', 'conversa que ja vinha sendo atendida nao passa a contar', '0',
  public._t_fila('op_g@test.local')::text);

-- SYNC_INICIAL não é envio de agora
select public._t_conversa(:'c10', '5551950000012') as r12 \gset
select public._t_msg(:'r12', 'ENTRADA', 1);
select public._t_assumir(:'r12', 'op_b@test.local', 600);
select public._t_registrar(:'r12', 'op_b@test.local', 'ENVIADO', 'w-r12-1', 300, 'SYNC_INICIAL');
insert into _cota_r values ('R12', 'SAIDA de SYNC_INICIAL nao conta', '0',
  public._t_fila('op_b@test.local')::text);

-- falha aberto: erro no registro da fila não desfaz a mensagem
select public._t_conversa(:'c10', '5551950000013') as r13 \gset
select public._t_msg(:'r13', 'ENTRADA', 1);
select public._t_assumir(:'r13', 'op_b@test.local', 600);
alter table public.receptivo_atendimentos_log
  add constraint _t_recusa_whatsapp check (fonte <> 'WHATSAPP') not valid;
select public._t_registrar(:'r13', 'op_b@test.local', 'ENVIADO', 'w-r13-1', 300);
alter table public.receptivo_atendimentos_log drop constraint _t_recusa_whatsapp;
insert into _cota_r values ('R13', 'erro na fila: mensagem fica registrada, atendimento nao', '1|0',
  (select count(*)::text from public.whatsapp_mensagens where wamid = 'w-r13-1') || '|' ||
  public._t_fila('op_b@test.local'));

-- RPC antiga (tela antiga, no assumir) + trigger no mesmo ciclo = 1
select public._t_conversa(:'c10', '5551950000014') as r14 \gset
select public._t_msg(:'r14', 'ENTRADA', 1);
select public._t_assumir(:'r14', 'op_g@test.local', 600);
set teste.email = 'op_g@test.local';
select public.fila_receptivo_marcar_atendido('op_g@test.local', :'r14', 'WHATSAPP');
reset teste.email;
select public._t_registrar(:'r14', 'op_g@test.local', 'ENVIADO', 'w-r14-1', 300);
insert into _cota_r values ('R14', 'tela antiga marcou no assumir + resposta: segue 1 no ciclo', '1|1',
  public._t_log('op_g@test.local') || '|' || public._t_fila('op_g@test.local'));

-- botão "Marcar" da FilaReceptivo (MANUAL) segue igual
set teste.email = 'sup_cota@test.local';
select public.fila_receptivo_marcar_atendido('op_g@test.local');
reset teste.email;
insert into _cota_r values ('R15', 'botao Marcar (MANUAL, gestao para outro) segue contando', '2',
  public._t_fila('op_g@test.local')::text);

-- ============== S. responder não altera a cota ATIVA =======================
-- op_g já tem 1 receptivo respondido (R14) e 1 marcação manual (R15).
-- Mais 9 conversas assumidas e respondidas = 10 receptivos respondidos.
select count(*) from (
  select public._t_conversa(:'c10', '55519512' || lpad(g::text, 5, '0')) c from generate_series(1, 9) g) x;
select public._t_msg(id, 'ENTRADA', 1), public._t_assumir(id, 'op_g@test.local', 600)
  from public.whatsapp_conversas where telefone_e164 like '55519512%';
select public._t_registrar(id, 'op_g@test.local', 'ENVIADO', 'w-s-' || telefone_e164, 300)
  from public.whatsapp_conversas where telefone_e164 like '55519512%';
insert into _cota_r values ('S1', '10 receptivos respondidos: fila 11 (10 + 1 manual), cota ATIVA 0', '11|0',
  public._t_fila('op_g@test.local') || '|' || public._t_cota(:'c10', 'op_g@test.local'));
insert into _cota_r
select 'S2', 'depois de 10 respostas, ainda inicia 10 abordagens ativas', '10',
       count(*) filter (where r = 'NOVA_ABORDAGEM')::text
  from (select public._t_checar(:'c10',
                 public._t_conversa(:'c10', '55519513' || lpad(g::text, 5, '0')),
                 'op_g@test.local') r
          from generate_series(1, 10) g) x;
insert into _cota_r values ('S3', 'e a 11a ativa e barrada', 'LIMITE_OPERADOR',
  public._t_checar(:'c10', public._t_conversa(:'c10', '5551951399999'), 'op_g@test.local'));

-- ===================== F. o que a tela lê e grava ==========================
set teste.email = 'op_g@test.local';
insert into _cota_r
select 'F1', 'consumo do operador: limite 10, usadas 10 (so ATIVA), sem isencao, configurado 10', '10|10|false|10',
       limite_operador || '|' || usadas_operador || '|' || sem_limite_individual || '|' || limite_operador_canal
  from public.whatsapp_cadencia_consumo() where canal_id = :'c10';

set teste.email = 'op_a@test.local';
insert into _cota_r
select 'F2', 'consumo: extra do dia soma em limite_operador, nao em limite_operador_canal', '11|10',
       limite_operador || '|' || limite_operador_canal
  from public.whatsapp_cadencia_consumo() where canal_id = :'c10';

set teste.email = 'ger_cota@test.local';
insert into _cota_r
select 'F3', 'consumo da gerencia: sem_limite_individual = true', 'true',
       sem_limite_individual::text
  from public.whatsapp_cadencia_consumo() where canal_id = :'c10';

insert into _cota_r values ('F4', 'config: teto_abordagens_operador = 10', '10',
  (select teto_abordagens_operador::text from public.whatsapp_config));
insert into _cota_r values ('F5', 'canais reais com limite 10 (Cobranca, Comercial, Piloto)', '10|10|10',
  (select string_agg(limite_abordagens_operador::text, '|' order by apelido)
     from public.whatsapp_canais where id in ('b8f00c75-aee3-4d22-83b7-f0041be0ef71',
       '9f5fc202-3a22-4b24-8794-65fd92858e31', '3628d3fd-ab44-4c47-bf42-3d344c1e9336')));
insert into _cota_r values ('F6', 'teto de canal NAO alterado (Comercial 60, Cobranca 40)', '40|60',
  (select string_agg(limite_abordagens_canal::text, '|' order by apelido)
     from public.whatsapp_canais where id in ('b8f00c75-aee3-4d22-83b7-f0041be0ef71',
       '9f5fc202-3a22-4b24-8794-65fd92858e31')));

create or replace function pg_temp._salvar(p_lim integer) returns text language plpgsql as $$
begin
  perform public.whatsapp_canal_cadencia_salvar('b8f00c75-aee3-4d22-83b7-f0041be0ef71',
            'ATIVO_CONTROLADO', p_lim, 60, '00:00', '23:59');
  return 'OK';
exception when others then
  return sqlstate;
end $$;
insert into _cota_r values ('F7', 'tela grava 10; 11 e recusado pela trava', 'OK|42501',
  pg_temp._salvar(10) || '|' || pg_temp._salvar(11));
reset teste.email;

-- ============================== H. grants ==================================
insert into _cota_r values
 ('H1', 'checar: authenticated SEM execute (estado de producao)', 'false',
   has_function_privilege('authenticated', 'public.whatsapp_cadencia_checar(uuid, uuid, text)', 'EXECUTE')::text),
 ('H2', 'checar: anon SEM execute', 'false',
   has_function_privilege('anon', 'public.whatsapp_cadencia_checar(uuid, uuid, text)', 'EXECUTE')::text),
 ('H3', 'helper de perfil: authenticated SEM execute', 'false',
   has_function_privilege('authenticated', 'public.whatsapp_cadencia_sem_limite_individual(text)', 'EXECUTE')::text),
 ('H4', 'registro interno da fila: authenticated SEM execute', 'false',
   has_function_privilege('authenticated', 'public.fila_receptivo_registrar_atendimento(text, uuid)', 'EXECUTE')::text),
 ('H5', 'registro interno da fila: anon SEM execute', 'false',
   has_function_privilege('anon', 'public.fila_receptivo_registrar_atendimento(text, uuid)', 'EXECUTE')::text),
 ('H6', 'marcar_atendido: authenticated COM execute (como em producao)', 'true',
   has_function_privilege('authenticated', 'public.fila_receptivo_marcar_atendido(text, uuid, text)', 'EXECUTE')::text),
 ('H7', 'marcar_atendido: anon SEM execute', 'false',
   has_function_privilege('anon', 'public.fila_receptivo_marcar_atendido(text, uuid, text)', 'EXECUTE')::text),
 ('H8', 'consumo: authenticated COM, anon SEM', 'true|false',
   has_function_privilege('authenticated', 'public.whatsapp_cadencia_consumo()', 'EXECUTE')::text || '|' ||
   has_function_privilege('anon', 'public.whatsapp_cadencia_consumo()', 'EXECUTE')::text),
 ('H9', 'funcao do trigger: authenticated SEM execute', 'false',
   has_function_privilege('authenticated', 'public.whatsapp_receptivo_atendimento_na_resposta()', 'EXECUTE')::text);

-- RPC pública continua barrando operador que tenta marcar por outro
set teste.email = 'op_b@test.local';
create or replace function pg_temp._marcar_outro() returns text language plpgsql as $$
begin
  perform public.fila_receptivo_marcar_atendido('op_g@test.local');
  return 'OK';
exception when others then
  return sqlstate;
end $$;
insert into _cota_r values ('H10', 'marcar_atendido: operador comum nao marca por outro', '42501',
  pg_temp._marcar_outro());
reset teste.email;

-- ====================== I. proteções preservadas ===========================
select public._t_canal('_cota_sr', 'SOMENTE_RESPOSTAS', 10, null) as csr,
       public._t_canal('_cota_pz', 'PAUSADO', 10, null) as cpz \gset
insert into _cota_r values ('I1', 'SOMENTE_RESPOSTAS barra nova conversa da gestao', 'MODO_SOMENTE_RESPOSTAS',
  public._t_checar(:'csr', public._t_conversa(:'csr', '5551960000003'), 'sup_cota@test.local'));
select public._t_conversa(:'cpz', '5551960000004') as i2 \gset
select public._t_msg(:'i2', 'ENTRADA', 1);
insert into _cota_r values ('I2', 'PAUSADO barra ate resposta da gestao', 'MODO_PAUSADO',
  public._t_checar(:'cpz', :'i2', 'ger_cota@test.local'));

select case when extract(hour from (now() at time zone 'America/Sao_Paulo')) < 12
            then '13:00' else '02:00' end as fj_ini,
       case when extract(hour from (now() at time zone 'America/Sao_Paulo')) < 12
            then '14:00' else '03:00' end as fj_fim \gset
select public._t_canal('_cota_fj', 'ATIVO_CONTROLADO', 10, null, :'fj_ini', :'fj_fim') as cfj \gset
insert into _cota_r values ('I3', 'fora da janela barra nova conversa da gestao', 'FORA_DA_JANELA',
  public._t_checar(:'cfj', public._t_conversa(:'cfj', '5551960000005'), 'adm_cota@test.local'));

insert into _cota_r values ('I4', 'resposta_janela_horas segue 24 e continuidade 72h/3', '24|72|3',
  (select resposta_janela_horas || '|' || continuidade_janela_horas || '|' || continuidade_max_sem_resposta
     from public.whatsapp_config));

insert into _cota_r values ('I5', 'gatilho novo dispara antes de trg_whatsapp_aguardando', 'trg_whatsapp_a0_receptivo_atendimento',
  (select tgname::text from pg_trigger
    where tgrelid = 'public.whatsapp_mensagens'::regclass and not tgisinternal
      and tgname in ('trg_whatsapp_a0_receptivo_atendimento', 'trg_whatsapp_aguardando')
    order by tgname limit 1));

-- ============================== resultado ==================================
select n, caso, esperado, obtido,
       case when obtido is not distinct from esperado then 'OK' else 'FALHOU' end as veredito
  from _cota_r order by n;

do $final$
declare v_falhas integer; v_total integer;
begin
  select count(*) filter (where obtido is distinct from esperado), count(*)
    into v_falhas, v_total from _cota_r;
  raise notice 'COTA 10 + FILA: % assercoes, % falhas', v_total, v_falhas;
  if v_total < 60 then
    raise exception 'esperava ao menos 60 assercoes, rodaram %', v_total using errcode = '22023';
  end if;
  if v_falhas > 0 then
    raise exception '% assercoes falharam', v_falhas using errcode = '22023';
  end if;
end $final$;
