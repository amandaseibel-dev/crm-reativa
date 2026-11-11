-- CASOS — COTA 10 POR OPERADOR (20261111150000)
--
-- Pré-condição: ambiente da v2 + migration v2 + 01_ambiente_cota.sql +
-- migration da cota 10, nesta ordem.
--
-- Cada passo é um STATEMENT PRÓPRIO (autocommit), como em produção:
-- assumir, preparar, enviar e registrar são transações diferentes, e o
-- ciclo de responsabilidade depende de now() mudar entre elas.
--
-- Janela 00:00-23:59 nos canais de teste e idades relativas (segundos ou
-- horas atrás), nunca data absoluta.
--
-- MAPA DO PEDIDO -> CASOS
--   limite 10 por operador, mesma contagem ............ A1-A5
--   gerência/supervisão/administrativo sem limite ..... B1-B6
--   teto global só com ATIVA, vale para todos ......... C1-C3
--   respostas e continuidade não gastam ............... D1-D4
--   receptivo: assumir não conta ...................... E1
--   receptivo: FALHA de envio não conta ............... E2
--   receptivo: marca DEPOIS da 1a resposta com sucesso  E3
--   receptivo: REPETIÇÃO conta uma vez só ............. E4, E5 (+ corrida real no 04)
--   receptivo: TROCA de responsável = ciclo novo ...... E6, E7
--   receptivo: bordas ................................. E8-E14
--   tela (consumo / salvar / indicadores) ............. F1-F7
--   grants ............................................ H1-H8
--   preservados: intervalo, modos, janela ............. I1-I5

\set ON_ERROR_STOP on

select public._t_canal('_cota10', 'ATIVO_CONTROLADO', 10, null) as c10 \gset
select public._t_canal('_cota_teto', 'ATIVO_CONTROLADO', 10, 3) as cteto \gset
select public._t_canal('_cota_teto2', 'ATIVO_CONTROLADO', 10, 2) as cteto2 \gset

-- ============================ A. limite 10 ================================
insert into _cota_r
select 'A1', '10 novas conversas do operador passam', '10',
       count(*) filter (where r = 'NOVA_ABORDAGEM')::text
  from (select public._t_checar(:'c10',
                 public._t_conversa(:'c10', '55519100000' || lpad(g::text, 2, '0')),
                 'op_a@test.local') r
          from generate_series(1, 10) g) x;

insert into _cota_r values ('A2', '11a nova conversa e barrada', 'LIMITE_OPERADOR',
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
select 'B' || p.n, p.email || ': 12 novas conversas passam', '12',
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

insert into _cota_r values ('B6', 'abordagem da gestao segue gravada como ATIVA (para o teto do canal)', '12',
  (select count(*)::text from public.whatsapp_abordagens
    where canal_id = :'c10' and operador_email = 'ger_cota@test.local' and origem = 'ATIVA'));

-- ===================== C. teto do canal (só ATIVA) ========================
insert into _cota_r
select 'C1', 'gestao sem limite individual respeita o teto do canal (3)', '3|LIMITE_CANAL',
       (select count(*) filter (where r = 'NOVA_ABORDAGEM')
          from (select public._t_checar(:'cteto',
                         public._t_conversa(:'cteto', '55519300' || lpad(g::text, 5, '0')),
                         'ger_cota@test.local') r
                  from generate_series(1, 3) g) x)::text
       || '|' || public._t_checar(:'cteto', public._t_conversa(:'cteto', '5551930099999'), 'ger_cota@test.local');

-- Teto 2 no canal; op_b responde 3 alunos que escreveram (3 marcas RECEPTIVA)
select public._t_conversa(:'cteto2', '5551931000001') as t2a,
       public._t_conversa(:'cteto2', '5551931000002') as t2b,
       public._t_conversa(:'cteto2', '5551931000003') as t2c \gset
select public._t_msg(:'t2a', 'ENTRADA', 1), public._t_msg(:'t2b', 'ENTRADA', 1), public._t_msg(:'t2c', 'ENTRADA', 1);
select public._t_assumir(:'t2a', 'op_b@test.local', 600),
       public._t_assumir(:'t2b', 'op_b@test.local', 600),
       public._t_assumir(:'t2c', 'op_b@test.local', 600);
select public._t_registrar(:'t2a', 'op_b@test.local', 'ENVIADO', 'w-c2-a', 300);
select public._t_registrar(:'t2b', 'op_b@test.local', 'ENVIADO', 'w-c2-b', 300);
select public._t_registrar(:'t2c', 'op_b@test.local', 'ENVIADO', 'w-c2-c', 300);

insert into _cota_r values ('C2', '3 marcas RECEPTIVA gravadas no canal de teto 2', '3',
  (select count(*)::text from public.whatsapp_abordagens where canal_id = :'cteto2' and origem = 'RECEPTIVA'));

insert into _cota_r
select 'C3', 'RECEPTIVA nao gasta teto do canal: 2 ATIVAS passam, 3a barrada', '2|LIMITE_CANAL',
       (select count(*) filter (where r = 'NOVA_ABORDAGEM')
          from (select public._t_checar(:'cteto2',
                         public._t_conversa(:'cteto2', '55519320' || lpad(g::text, 5, '0')),
                         'op_c@test.local') r
                  from generate_series(1, 2) g) x)::text
       || '|' || public._t_checar(:'cteto2', public._t_conversa(:'cteto2', '5551932099999'), 'op_c@test.local');

-- ============== D. resposta e continuidade não gastam cota =================
select public._t_conversa(:'c10', '5551940000001') as d1,
       public._t_conversa(:'c10', '5551940000002') as d2,
       public._t_conversa(:'c10', '5551940000003') as d3,
       public._t_conversa(:'c10', '5551940000004') as d4 \gset
select public._t_msg(:'d1', 'ENTRADA', 2);
-- cenário de CONTINUIDADE da v2 (caso 1): envio anterior era RESPOSTA, aluno respondeu há 40h
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

-- ======================== E. receptivo ====================================
select public._t_conversa(:'c10', '5551950000001') as e1 \gset
select public._t_msg(:'e1', 'ENTRADA', 1);

-- E1: assumir não conta
select public._t_assumir(:'e1', 'op_e@test.local', 600);
insert into _cota_r values ('E1', 'ASSUMIR a conversa nao marca cota', '0|0',
  public._t_marcas(:'e1', 'op_e@test.local', 'RECEPTIVA') || '|' || public._t_cota(:'c10', 'op_e@test.local'));

-- E2: falha de envio não conta (a Edge registra FALHOU com wamid "falha:...")
select public._t_registrar(:'e1', 'op_e@test.local', 'FALHOU', 'falha:e1:1', 500);
insert into _cota_r values ('E2', 'FALHA de envio nao marca cota', '0|0',
  public._t_marcas(:'e1', 'op_e@test.local', 'RECEPTIVA') || '|' || public._t_cota(:'c10', 'op_e@test.local'));

-- E3: primeira resposta com sucesso marca, com o ciclo de responsabilidade
select public._t_registrar(:'e1', 'op_e@test.local', 'ENVIADO', 'w-e1-1', 400);
insert into _cota_r values ('E3', 'primeira resposta ENVIADA marca 1 RECEPTIVA; resposta nao gasta cota', '1|0',
  public._t_marcas(:'e1', 'op_e@test.local', 'RECEPTIVA') || '|' || public._t_cota(:'c10', 'op_e@test.local'));
insert into _cota_r values ('E3b', 'marca guarda o ciclo (responsavel_desde) e o wamid', 'true|w-e1-1',
  (select (a.ciclo_desde = cv.responsavel_desde)::text || '|' || a.wamid
     from public.whatsapp_abordagens a join public.whatsapp_conversas cv on cv.id = a.conversa_id
    where a.conversa_id = :'e1' and a.operador_email = 'op_e@test.local' and a.origem = 'RECEPTIVA'));

-- E4: repetição do MESMO registro (mesmo wamid) — idempotência existente
select public._t_registrar(:'e1', 'op_e@test.local', 'ENVIADO', 'w-e1-1', 400);
insert into _cota_r values ('E4', 'REPETICAO do mesmo wamid nao marca de novo', '1',
  public._t_marcas(:'e1', 'op_e@test.local', 'RECEPTIVA')::text);

-- E5: segunda resposta no mesmo ciclo
select public._t_registrar(:'e1', 'op_e@test.local', 'ENVIADO', 'w-e1-2', 350);
insert into _cota_r values ('E5', 'segunda resposta no MESMO ciclo nao marca de novo; cota segue 0', '1|0',
  public._t_marcas(:'e1', 'op_e@test.local', 'RECEPTIVA') || '|' || public._t_cota(:'c10', 'op_e@test.local'));

-- E6: troca de responsável (transferência) = ciclo novo para quem recebe
select public._t_assumir(:'e1', 'op_f@test.local', 300);
insert into _cota_r values ('E6a', 'TROCA: receber a conversa nao marca', '0',
  public._t_marcas(:'e1', 'op_f@test.local', 'RECEPTIVA')::text);
select public._t_registrar(:'e1', 'op_f@test.local', 'ENVIADO', 'w-e1-3', 250);
insert into _cota_r values ('E6b', 'TROCA: 1a resposta do novo responsavel marca; cota segue 0', '1|0|1',
  public._t_marcas(:'e1', 'op_f@test.local', 'RECEPTIVA') || '|' ||
  public._t_cota(:'c10', 'op_f@test.local') || '|' ||
  public._t_marcas(:'e1', 'op_e@test.local', 'RECEPTIVA'));

-- E7: volta ao primeiro operador (retirar + assumir) = outro ciclo
select public._t_retirar(:'e1');
select public._t_assumir(:'e1', 'op_e@test.local', 200);
select public._t_registrar(:'e1', 'op_e@test.local', 'ENVIADO', 'w-e1-4', 150);
insert into _cota_r values ('E7', 'ciclo novo marca de novo; respostas nao gastam cota', '2|0',
  public._t_marcas(:'e1', 'op_e@test.local', 'RECEPTIVA') || '|' || public._t_cota(:'c10', 'op_e@test.local'));

-- E8: quem envia não é o responsável (gestão respondendo conversa do operador)
select public._t_registrar(:'e1', 'sup_cota@test.local', 'ENVIADO', 'w-e1-5', 140);
insert into _cota_r values ('E8', 'envio de quem NAO e o responsavel nao marca ninguem', '0|2',
  public._t_marcas(:'e1', 'sup_cota@test.local', 'RECEPTIVA') || '|' ||
  public._t_marcas(:'e1', 'op_e@test.local', 'RECEPTIVA'));

-- E9: gestão responsável não marca (sem limite individual)
select public._t_conversa(:'c10', '5551950000009') as e9 \gset
select public._t_msg(:'e9', 'ENTRADA', 1);
select public._t_assumir(:'e9', 'adm_cota@test.local', 600);
select public._t_registrar(:'e9', 'adm_cota@test.local', 'ENVIADO', 'w-e9-1', 300);
insert into _cota_r values ('E9', 'administrativo responsavel nao recebe marca', '0',
  public._t_marcas(:'e9', 'adm_cota@test.local', 'RECEPTIVA')::text);

-- E10: ciclo aberto por NOVA_ABORDAGEM já está contado (ATIVA): o envio não soma
select public._t_conversa(:'c10', '5551950000010') as e10 \gset
insert into _cota_r values ('E10a', 'operador inicia conversa (preparar_envio)', 'NOVA_ABORDAGEM',
  public._t_preparar(:'c10', :'e10', 'op_c@test.local'));
select public._t_registrar(:'e10', 'op_c@test.local', 'ENVIADO', 'w-e10-1');
insert into _cota_r values ('E10b', 'ciclo aberto por ATIVA: envio nao gera RECEPTIVA; cota 1', '1|0|1',
  public._t_marcas(:'e10', 'op_c@test.local', 'ATIVA') || '|' ||
  public._t_marcas(:'e10', 'op_c@test.local', 'RECEPTIVA') || '|' ||
  public._t_cota(:'c10', 'op_c@test.local'));

-- E11: ciclo antigo (anterior à migration), operador já tinha respondido nele
select public._t_conversa(:'c10', '5551950000011') as e11 \gset
select public._t_msg(:'e11', 'ENTRADA', 1);
select public._t_assumir(:'e11', 'op_g@test.local', 7200);
alter table public.whatsapp_mensagens disable trigger trg_whatsapp_cadencia_receptiva;
select public._t_registrar(:'e11', 'op_g@test.local', 'ENVIADO', 'w-e11-legado', 3600);
alter table public.whatsapp_mensagens enable trigger trg_whatsapp_cadencia_receptiva;
select public._t_registrar(:'e11', 'op_g@test.local', 'ENVIADO', 'w-e11-1', 120);
insert into _cota_r values ('E11', 'conversa que ja vinha sendo atendida nao passa a gastar cota', '0',
  public._t_marcas(:'e11', 'op_g@test.local', 'RECEPTIVA')::text);

-- E12: RECEPTIVA NAO consome a cota (so ATIVA conta); nunca barra a resposta
--      op_f já tem 1 (E6). Mais 9 conversas assumidas e respondidas = 10.
select count(*) from (
  select public._t_conversa(:'c10', '55519512' || lpad(g::text, 5, '0')) c from generate_series(1, 9) g) x;
select public._t_msg(id, 'ENTRADA', 1), public._t_assumir(id, 'op_f@test.local', 600)
  from public.whatsapp_conversas where telefone_e164 like '55519512%';
select public._t_registrar(id, 'op_f@test.local', 'ENVIADO', 'w-e12-' || telefone_e164, 300)
  from public.whatsapp_conversas where telefone_e164 like '55519512%';
insert into _cota_r values ('E12a', '10 conversas receptivas respondidas: cota continua 0', '0',
  public._t_cota(:'c10', 'op_f@test.local')::text);
insert into _cota_r values ('E12b', 'receptivas nao gastam cota: nova abordagem continua liberada', 'NOVA_ABORDAGEM',
  public._t_checar(:'c10', public._t_conversa(:'c10', '5551951299999'), 'op_f@test.local'));
select public._t_conversa(:'c10', '5551951300001') as e12x \gset
select public._t_msg(:'e12x', 'ENTRADA', 1);
insert into _cota_r values ('E12c', 'com a cota cheia, RESPONDER quem escreveu continua liberado', 'RESPOSTA',
  public._t_preparar(:'c10', :'e12x', 'op_f@test.local'));
select public._t_registrar(:'e12x', 'op_f@test.local', 'ENVIADO', 'w-e12x-1', 0);
insert into _cota_r values ('E12d', 'receptivas nao contam: so a ATIVA do E12b (cota 1)', '1',
  public._t_cota(:'c10', 'op_f@test.local')::text);

-- E13: mensagem de sincronização inicial não é envio de agora
select public._t_conversa(:'c10', '5551950000013') as e13 \gset
select public._t_assumir(:'e13', 'op_b@test.local', 600);
select public._t_registrar(:'e13', 'op_b@test.local', 'ENVIADO', 'w-e13-1', 300, 'SYNC_INICIAL');
insert into _cota_r values ('E13', 'SAIDA de SYNC_INICIAL nao marca', '0',
  public._t_marcas(:'e13', 'op_b@test.local', 'RECEPTIVA')::text);

-- E14: falha ABERTO — erro na marcação não desfaz o registro da mensagem
select public._t_conversa(:'c10', '5551950000014') as e14 \gset
select public._t_assumir(:'e14', 'op_b@test.local', 600);
alter table public.whatsapp_abordagens
  add constraint _t_recusa_receptiva check (origem <> 'RECEPTIVA') not valid;
select public._t_registrar(:'e14', 'op_b@test.local', 'ENVIADO', 'w-e14-1', 300);
alter table public.whatsapp_abordagens drop constraint _t_recusa_receptiva;
insert into _cota_r values ('E14', 'marcacao com erro: mensagem fica registrada, marca nao', '1|0',
  (select count(*)::text from public.whatsapp_mensagens where wamid = 'w-e14-1') || '|' ||
  public._t_marcas(:'e14', 'op_b@test.local', 'RECEPTIVA'));

-- ===================== F. o que a tela lê e grava ==========================
set teste.email = 'op_f@test.local';
insert into _cota_r
select 'F1', 'consumo do operador: limite 10, usadas 1 (so ATIVA), sem isencao, configurado 10', '10|1|false|10',
       limite_operador || '|' || usadas_operador || '|' || sem_limite_individual || '|' || limite_operador_canal
  from public.whatsapp_cadencia_consumo() where canal_id = :'c10';

insert into _cota_r
select 'F2', 'consumo: teto do canal conta so ATIVA', (select count(*)::text from public.whatsapp_abordagens
                                                        where canal_id = :'c10' and origem = 'ATIVA'),
       usadas_canal::text
  from public.whatsapp_cadencia_consumo() where canal_id = :'c10';

set teste.email = 'op_a@test.local';
insert into _cota_r
select 'F3', 'consumo: extra do dia soma em limite_operador, nao em limite_operador_canal', '11|10',
       limite_operador || '|' || limite_operador_canal
  from public.whatsapp_cadencia_consumo() where canal_id = :'c10';

set teste.email = 'ger_cota@test.local';
insert into _cota_r
select 'F4', 'consumo da gerencia: sem_limite_individual = true', 'true',
       sem_limite_individual::text
  from public.whatsapp_cadencia_consumo() where canal_id = :'c10';

insert into _cota_r values ('F5', 'config: teto_abordagens_operador = 10', '10',
  (select teto_abordagens_operador::text from public.whatsapp_config));
insert into _cota_r values ('F6', 'canais reais com limite 10 (Comercial, Cobranca, Piloto)', '10|10|10',
  (select string_agg(limite_abordagens_operador::text, '|' order by apelido)
     from public.whatsapp_canais where id in ('b8f00c75-aee3-4d22-83b7-f0041be0ef71',
       '9f5fc202-3a22-4b24-8794-65fd92858e31', '3628d3fd-ab44-4c47-bf42-3d344c1e9336')));

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

insert into _cota_r
select 'F8', 'indicadores: abordagens do canal de teto 2 = so ATIVA (2), sem as 3 RECEPTIVAS', '2',
       abordagens::text
  from public.whatsapp_cadencia_indicadores(7) where canal_apelido = 'Teste _cota_teto2';
reset teste.email;

-- ============================== H. grants ==================================
insert into _cota_r values
 ('H1', 'checar: authenticated SEM execute (estado de producao)', 'false',
   has_function_privilege('authenticated', 'public.whatsapp_cadencia_checar(uuid, uuid, text)', 'EXECUTE')::text),
 ('H2', 'checar: anon SEM execute', 'false',
   has_function_privilege('anon', 'public.whatsapp_cadencia_checar(uuid, uuid, text)', 'EXECUTE')::text),
 ('H3', 'helper de perfil: authenticated SEM execute', 'false',
   has_function_privilege('authenticated', 'public.whatsapp_cadencia_sem_limite_individual(text)', 'EXECUTE')::text),
 ('H4', 'helper de perfil: anon SEM execute', 'false',
   has_function_privilege('anon', 'public.whatsapp_cadencia_sem_limite_individual(text)', 'EXECUTE')::text),
 ('H5', 'consumo: authenticated COM execute', 'true',
   has_function_privilege('authenticated', 'public.whatsapp_cadencia_consumo()', 'EXECUTE')::text),
 ('H6', 'consumo: anon SEM execute', 'false',
   has_function_privilege('anon', 'public.whatsapp_cadencia_consumo()', 'EXECUTE')::text),
 ('H7', 'funcao do trigger: authenticated SEM execute', 'false',
   has_function_privilege('authenticated', 'public.whatsapp_cadencia_marcar_receptiva()', 'EXECUTE')::text),
 ('H8', 'indicadores: anon SEM execute', 'false',
   has_function_privilege('anon', 'public.whatsapp_cadencia_indicadores(integer)', 'EXECUTE')::text);

-- ====================== I. proteções preservadas ===========================
-- I1: intervalo mínimo vale para a gestão também
select public._t_conversa(:'c10', '5551960000001') as i1a,
       public._t_conversa(:'c10', '5551960000002') as i1b \gset
select public._t_assumir(:'i1a', 'ger_cota@test.local', 5);
select public._t_registrar(:'i1a', 'ger_cota@test.local', 'ENVIADO', 'w-i1-1', 0);
insert into _cota_r values ('I1', 'intervalo minimo vale para gerencia (sem limite de cota)', 'INTERVALO_MINIMO',
  public._t_checar(:'c10', :'i1b', 'ger_cota@test.local'));

select public._t_canal('_cota_sr', 'SOMENTE_RESPOSTAS', 10, null) as csr,
       public._t_canal('_cota_pz', 'PAUSADO', 10, null) as cpz \gset
insert into _cota_r values ('I2', 'SOMENTE_RESPOSTAS barra nova conversa da gestao', 'MODO_SOMENTE_RESPOSTAS',
  public._t_checar(:'csr', public._t_conversa(:'csr', '5551960000003'), 'sup_cota@test.local'));
select public._t_conversa(:'cpz', '5551960000004') as i3 \gset
select public._t_msg(:'i3', 'ENTRADA', 1);
insert into _cota_r values ('I3', 'PAUSADO barra ate resposta da gestao', 'MODO_PAUSADO',
  public._t_checar(:'cpz', :'i3', 'ger_cota@test.local'));

select case when extract(hour from (now() at time zone 'America/Sao_Paulo')) < 12
            then '13:00' else '02:00' end as fj_ini,
       case when extract(hour from (now() at time zone 'America/Sao_Paulo')) < 12
            then '14:00' else '03:00' end as fj_fim \gset
select public._t_canal('_cota_fj', 'ATIVO_CONTROLADO', 10, null, :'fj_ini', :'fj_fim') as cfj \gset
insert into _cota_r values ('I4', 'fora da janela barra nova conversa da gestao', 'FORA_DA_JANELA',
  public._t_checar(:'cfj', public._t_conversa(:'cfj', '5551960000005'), 'adm_cota@test.local'));

insert into _cota_r values ('I5', 'resposta_janela_horas segue 24 e continuidade 72h/3', '24|72|3',
  (select resposta_janela_horas || '|' || continuidade_janela_horas || '|' || continuidade_max_sem_resposta
     from public.whatsapp_config));

-- ============================== resultado ==================================
select n, caso, esperado, obtido,
       case when obtido is not distinct from esperado then 'OK' else 'FALHOU' end as veredito
  from _cota_r order by n;

do $final$
declare v_falhas integer; v_total integer;
begin
  select count(*) filter (where obtido is distinct from esperado), count(*)
    into v_falhas, v_total from _cota_r;
  raise notice 'COTA 10: % assercoes, % falhas', v_total, v_falhas;
  if v_total < 50 then
    raise exception 'esperava ao menos 50 assercoes, rodaram %', v_total using errcode = '22023';
  end if;
  if v_falhas > 0 then
    raise exception '% assercoes falharam', v_falhas using errcode = '22023';
  end if;
end $final$;
