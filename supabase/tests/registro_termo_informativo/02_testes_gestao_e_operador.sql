-- TESTES (sessão de LOGIN app_teste, membro de authenticated; session_user não é postgres, então o bypass não se aplica).
\set ON_ERROR_STOP on
select set_config('request.jwt.claims', '{"email":"gestao.titular@exemplo.local","role":"authenticated"}', false);
set role authenticated;

do $$
declare
  antes text; depois text; n_antes int; n_depois int; r text;
begin
  select row_to_json(a)::text || '|' || row_to_json(c)::text into antes
    from alunos a join casos c on c.aluno_id = a.id where a.id = 'a0000000-0000-0000-0000-000000000042';
  select count(*) into n_antes from aluno_movimentacoes where tipo = 'REGISTRO_TERMO_FISICO_INFORMATIVO';

  -- 1. Gestão grava o registro informativo.
  insert into aluno_movimentacoes (aluno_id, tipo, descricao, status_anterior, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
    values ('a0000000-0000-0000-0000-000000000042','REGISTRO_TERMO_FISICO_INFORMATIVO','Termo físico assinado pelo aluno e arquivado com a gestão.',null,null,'Gestão Teste','gestao.titular@exemplo.local',now());
  select count(*) into n_depois from aluno_movimentacoes where tipo = 'REGISTRO_TERMO_FISICO_INFORMATIVO';
  if n_depois <> n_antes + 1 then raise exception 'FALHOU 1: gestão não gravou o registro (antes=%, depois=%)', n_antes, n_depois; end if;
  raise notice 'PASS 1: gestão grava o registro informativo';

  -- 2. Autor e data/hora gravados na linha.
  if not exists (select 1 from aluno_movimentacoes where tipo = 'REGISTRO_TERMO_FISICO_INFORMATIVO'
                  and registrado_por_email = 'gestao.titular@exemplo.local' and registrado_em is not null) then
    raise exception 'FALHOU 2: autor/data ausentes na linha';
  end if;
  raise notice 'PASS 2: autor e data/hora gravados';

  -- 3. Status, prazo, próxima ação, retorno e último acionamento intactos.
  select row_to_json(a)::text || '|' || row_to_json(c)::text into depois
    from alunos a join casos c on c.aluno_id = a.id where a.id = 'a0000000-0000-0000-0000-000000000042';
  if antes is distinct from depois then raise exception 'FALHOU 3: aluno ou caso alterado pelo registro'; end if;
  raise notice 'PASS 3: aluno e caso inalterados (status, prazo, próxima ação, retorno, último acionamento)';

  -- 4. Operador comum é recusado pelo banco.
  perform set_config('request.jwt.claims', '{"email":"operador.teste@exemplo.local","role":"authenticated"}', true);
  r := esperar_erro($q$insert into aluno_movimentacoes (aluno_id, tipo, descricao, registrado_por_email, registrado_em)
       values ('a0000000-0000-0000-0000-000000000042','REGISTRO_TERMO_FISICO_INFORMATIVO','Termo físico assinado pelo aluno e arquivado com a gestão.','operador.teste@exemplo.local',now())$q$, '42501');
  if r <> 'OK:42501' then raise exception 'FALHOU 4: operador não foi recusado pelo banco: %', r; end if;
  raise notice 'PASS 4: operador comum recusado pelo banco (42501)';

  -- 5. Variante de caixa/espaço do mesmo tipo também é recusada.
  r := esperar_erro($q$insert into aluno_movimentacoes (aluno_id, tipo, descricao, registrado_por_email, registrado_em)
       values ('a0000000-0000-0000-0000-000000000042',' registro_termo_fisico_informativo ','x','operador.teste@exemplo.local',now())$q$, '42501');
  if r <> 'OK:42501' then raise exception 'FALHOU 5: variante do tipo não foi recusada: %', r; end if;
  raise notice 'PASS 5: variante de caixa e espaço recusada';

  -- 6. Preservação: operador continua gravando os demais tipos (sem exceção).
  insert into aluno_movimentacoes (aluno_id, tipo, descricao, registrado_por_email, registrado_em)
    values ('a0000000-0000-0000-0000-000000000042','OBSERVACAO_TESTE','outra observação do operador','operador.teste@exemplo.local',now());
  raise notice 'PASS 6: operador grava demais tipos';
end $$;
