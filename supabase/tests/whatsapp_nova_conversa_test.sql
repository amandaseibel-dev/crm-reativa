-- Testes: abrir conversa nova pela Central (operador escreve primeiro)
-- =============================================================================
-- COMO RODAR: cole num ambiente de TESTE (staging). O script cria dois canais
-- próprios, roda os casos e apaga tudo o que criou no fim. Não use em produção:
-- ele escreve em whatsapp_canais e whatsapp_conversas.
--
-- COMO SIMULA O OPERADOR: `set_config('request.jwt.claims', ...)` faz
-- `app_email()` e `app_usuario_ativo()` enxergarem o usuário desejado, que é
-- como a RPC decide quem está falando. Os e-mails abaixo precisam existir e
-- estar ativos em `public.usuarios` no ambiente de teste.
--
-- O QUE ESTES TESTES PROTEGEM, em ordem de importância:
--   * a trava de responsável — "Nova conversa" não pode ser a porta dos fundos
--     para dois operadores atenderem o mesmo aluno;
--   * a chave estável do telefone — o mesmo número em formatos diferentes tem
--     de cair sempre na MESMA conversa, senão o histórico se parte em duas;
--   * a fila "Sem retorno" — conversa que NÓS iniciamos não é alguém esperando
--     resposta, e não pode inflar o painel que a operação usa para priorizar.
-- =============================================================================
drop table if exists _wa_teste;
create table _wa_teste (n int, caso text, ok boolean, detalhe text);

do $teste$
declare
  v_canal_on uuid; v_canal_off uuid; v_r record;
  v_id1 uuid; v_id2 uuid; v_txt text; v_txt2 text; v_cnt int;
begin
  insert into public.whatsapp_canais (sessao_chave, display_phone_number, apelido, ativo, conexao_status, conectado_em)
  values ('t_on','+55 51 90000-0001','Teste ON', true,'CONECTADO', now()) returning id into v_canal_on;
  insert into public.whatsapp_canais (sessao_chave, display_phone_number, apelido, ativo, conexao_status)
  values ('t_off','+55 51 90000-0002','Teste OFF',true,'DESCONECTADO') returning id into v_canal_off;

  perform set_config('request.jwt.claims','{"email":"op1@test.local","role":"authenticated"}', true);

  begin
    perform * from public.whatsapp_preparar_envio_novo(v_canal_on,'123',null);
    insert into _wa_teste values (1,'telefone invalido recusa',false,'nao levantou erro');
  exception when others then
    insert into _wa_teste values (1,'telefone invalido recusa', sqlerrm like '%telefone invalido%', sqlerrm);
  end;

  -- Número fora do ar precisa recusar ANTES de criar a conversa: senão sobra
  -- conversa muda na caixa de entrada por causa de uma queda de conexão.
  begin
    perform * from public.whatsapp_preparar_envio_novo(v_canal_off,'51999990001',null);
    insert into _wa_teste values (2,'canal fora do ar recusa',false,'nao levantou erro');
  exception when others then
    insert into _wa_teste values (2,'canal fora do ar recusa', sqlerrm like '%DESCONECTADO%', sqlerrm);
  end;

  select * into v_r from public.whatsapp_preparar_envio_novo(v_canal_on,'(51) 99999-0001',null);
  v_id1 := v_r.conversa_id;
  insert into _wa_teste values (3,'numero novo cria conversa',
    v_r.conversa_id is not null and v_r.ja_existia = false and v_r.sessao_chave='t_on'
      and v_r.telefone_e164='5551999990001',
    format('ja_existia=%s sessao=%s e164=%s', v_r.ja_existia, v_r.sessao_chave, v_r.telefone_e164));

  select responsavel_email, status into v_txt, v_txt2 from public.whatsapp_conversas where id=v_id1;
  insert into _wa_teste values (4,'operador vira responsavel',
    v_txt='op1@test.local' and v_txt2='EM_ATENDIMENTO', format('resp=%s status=%s',v_txt,v_txt2));

  select count(*) into v_cnt from public.whatsapp_conversas where id=v_id1 and aguardando_resposta;
  insert into _wa_teste values (5,'conversa nova fora de Sem retorno', v_cnt=0, format('aguardando=%s',v_cnt));

  select * into v_r from public.whatsapp_preparar_envio_novo(v_canal_on,'+55 51 99999-0001',null);
  insert into _wa_teste values (6,'formato diferente reaproveita conversa',
    v_r.conversa_id = v_id1 and v_r.ja_existia = true, format('ja_existia=%s',v_r.ja_existia));

  select count(*) into v_cnt from public.whatsapp_conversas where canal_id=v_canal_on and telefone_e164='5551999990001';
  insert into _wa_teste values (7,'nao duplicou conversa', v_cnt=1, format('conversas=%s',v_cnt));

  select * into v_r from public.whatsapp_conversa_por_telefone(v_canal_on,'51 99999 0001');
  insert into _wa_teste values (8,'consulta previa acha existente',
    v_r.conversa_id=v_id1 and v_r.responsavel_email='op1@test.local', format('resp=%s',v_r.responsavel_email));

  select count(*) into v_cnt from public.whatsapp_conversa_por_telefone(v_canal_on,'51988880002');
  insert into _wa_teste values (9,'consulta previa vazia p/ numero novo', v_cnt=0, format('linhas=%s',v_cnt));

  select count(*) into v_cnt from public.whatsapp_conversa_por_telefone(v_canal_on,'abc');
  insert into _wa_teste values (10,'consulta previa tolera lixo', v_cnt=0, format('linhas=%s',v_cnt));

  perform set_config('request.jwt.claims','{"email":"op2@test.local","role":"authenticated"}', true);
  begin
    perform * from public.whatsapp_preparar_envio_novo(v_canal_on,'51999990001',null);
    insert into _wa_teste values (11,'outro operador e recusado',false,'nao levantou erro');
  exception when others then
    insert into _wa_teste values (11,'outro operador e recusado',
      sqlerrm like '%ja existe conversa%' and sqlerrm like '%OP1%', sqlerrm);
  end;

  perform set_config('request.jwt.claims','{"email":"amanda.seibel@aelbra.com.br","role":"authenticated"}', true);
  select * into v_r from public.whatsapp_preparar_envio_novo(v_canal_on,'51999990001',null);
  insert into _wa_teste values (12,'gestao nao e barrada', v_r.conversa_id=v_id1, format('id=%s',v_r.conversa_id));

  select responsavel_email into v_txt from public.whatsapp_conversas where id=v_id1;
  insert into _wa_teste values (13,'gestao nao rouba o responsavel', v_txt='op1@test.local', format('resp=%s',v_txt));

  update public.whatsapp_conversas set status='ENCERRADO' where id=v_id1;
  perform * from public.whatsapp_preparar_envio_novo(v_canal_on,'51999990001',null);
  select status into v_txt from public.whatsapp_conversas where id=v_id1;
  insert into _wa_teste values (14,'encerrada volta a EM_ATENDIMENTO', v_txt='EM_ATENDIMENTO', format('status=%s',v_txt));

  select * into v_r from public.whatsapp_preparar_envio_novo(v_canal_on,'51977770003', null);
  v_id2 := v_r.conversa_id;
  insert into _wa_teste values (15,'segundo numero cria outra conversa', v_id2 is distinct from v_id1, format('nova=%s',v_r.ja_existia));

  -- Fixo (8 dígitos, faixa 2-5) nunca ganha o nono dígito. Se ganhasse, o fixo
  -- 3333-4444 colidiria com o celular 9 3333-4444 — pessoas diferentes.
  select * into v_r from public.whatsapp_preparar_envio_novo(v_canal_on,'5133334444', null);
  insert into _wa_teste values (16,'telefone fixo aceito', v_r.telefone_e164='555133334444', format('e164=%s',v_r.telefone_e164));

  perform set_config('request.jwt.claims','{"email":"ninguem@fora.local","role":"authenticated"}', true);
  begin
    perform * from public.whatsapp_preparar_envio_novo(v_canal_on,'51966660004',null);
    insert into _wa_teste values (17,'usuario fora da base e recusado',false,'nao levantou erro');
  exception when others then
    insert into _wa_teste values (17,'usuario fora da base e recusado', sqlerrm like '%acesso negado%', sqlerrm);
  end;
  begin
    perform * from public.whatsapp_conversa_por_telefone(v_canal_on,'51999990001');
    insert into _wa_teste values (18,'consulta previa exige usuario ativo',false,'nao levantou erro');
  exception when others then
    insert into _wa_teste values (18,'consulta previa exige usuario ativo', sqlerrm like '%acesso negado%', sqlerrm);
  end;

  perform set_config('request.jwt.claims', null, true);
  delete from public.whatsapp_mensagens
   where conversa_id in (select id from public.whatsapp_conversas where canal_id in (v_canal_on,v_canal_off));
  delete from public.whatsapp_conversas    where canal_id in (v_canal_on, v_canal_off);
  delete from public.whatsapp_conexao_eventos where canal_id in (v_canal_on, v_canal_off);
  delete from public.whatsapp_canais       where id in (v_canal_on, v_canal_off);
end;
$teste$;

select n, caso, case when ok then 'PASSOU' else '>>> FALHOU' end as r, left(detalhe,95) as detalhe
from _wa_teste order by n;

drop table _wa_teste;
