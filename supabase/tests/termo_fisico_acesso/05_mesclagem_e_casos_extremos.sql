-- Mesclagem com registro de termo físico (decisão B) e casos extremos de acesso.
-- Roda POR ÚLTIMO: altera dados de teste (desativa um usuário temporariamente).
\set ON_ERROR_STOP on

-- ---------------------------------------------------------------------------
-- SIMULAÇÃO da lógica de mesclar_aluno_duplicado, NÃO a função real.
-- A real (supabase/migrations/20260827250000_mesclar_aluno_duplicado.sql) faz
-- UPDATE em toda tabela com coluna aluno_id, descoberta por information_schema,
-- em ordem alfabética, dentro de uma única chamada. Aqui reproduzimos esse
-- mecanismo para provar a propriedade que importa: falha de uma tabela no meio
-- desfaz as alterações das tabelas anteriores.
-- A tabela de teste se chama aaa_... para ser atualizada ANTES de
-- aluno_termo_fisico_eventos (ordem alfabética), o que torna o teste de
-- atomicidade significativo.
-- ---------------------------------------------------------------------------
create table public.aaa_teste_outra_tabela (id serial primary key, aluno_id text);
insert into public.aaa_teste_outra_tabela (aluno_id) values ('ORIGEM'), ('ORIGEM');

create or replace function public.teste_mescla(p_manter text, p_remover text)
returns integer
language plpgsql
as $$
declare
  r record;
  v_n integer;
  v_total integer := 0;
begin
  for r in
    select c.table_name
      from information_schema.columns c
      join information_schema.tables t
        on t.table_schema = c.table_schema and t.table_name = c.table_name
       and t.table_type = 'BASE TABLE'
     where c.table_schema = 'public' and c.column_name = 'aluno_id'
     order by c.table_name
  loop
    execute format('update public.%I set aluno_id = $1 where aluno_id = $2', r.table_name)
      using p_manter, p_remover;
    get diagnostics v_n = row_count;
    v_total := v_total + v_n;
  end loop;
  return v_total;
end;
$$;

-- Caso 1: origem SEM registro de termo -> mesclagem passa e move as linhas.
insert into public.aaa_teste_outra_tabela (aluno_id) values ('ORIGEM2');
select public.teste_assert('mescla sem termo: move as linhas da origem',
  public.teste_comando(null, null, 'select public.teste_mescla(''DESTINO'',''ORIGEM2'')')->>'ok' = 'true');
select public.teste_assert('mescla sem termo: origem sem termo é movida (linha de ORIGEM2 some)',
  (select count(*) from public.aaa_teste_outra_tabela where aluno_id = 'ORIGEM2') = 0);

-- Caso 2 (decisão B): origem COM registro de termo -> mesclagem recusada INTEIRA.
-- O registro é criado como dono (o histórico é append-only; nada é apagado).
insert into public.aluno_termo_fisico_eventos (aluno_id, situacao, autor_email)
values ('ORIGEM', 'EM_ANDAMENTO', 'amanda.seibel@aelbra.com.br');

select public.teste_assert('mescla com termo: recusada com erro claro (42501, menciona mesclagem)',
  (public.teste_comando(null, null, 'select public.teste_mescla(''DESTINO'',''ORIGEM'')')->>'code') = '42501'
  and (public.teste_comando(null, null, 'select public.teste_mescla(''DESTINO'',''ORIGEM'')')->>'err') like '%mesclagem%'
  and (public.teste_comando(null, null, 'select public.teste_mescla(''DESTINO'',''ORIGEM'')')->>'err') like '%decide manualmente%');

select public.teste_assert('mescla com termo: NENHUMA alteração parcial (tabela anterior segue com as 2 linhas de ORIGEM)',
  (select count(*) from public.aaa_teste_outra_tabela where aluno_id = 'ORIGEM') = 2
  and (select count(*) from public.aaa_teste_outra_tabela where aluno_id = 'DESTINO') = 1); -- a 1 linha do caso 1

select public.teste_assert('mescla com termo: registro de termo continua no aluno de origem (nada foi apagado nem movido)',
  (select count(*) from public.aluno_termo_fisico_eventos where aluno_id = 'ORIGEM') = 1);

-- ---------------------------------------------------------------------------
-- Casos extremos de acesso (usuário sem perfil, usuário inativo, p_notificar=false)
-- ---------------------------------------------------------------------------

-- Usuário autenticado SEM cadastro em usuarios: nem leitura, nem gravação.
select public.teste_assert('sem perfil: ler a RPC dá 42501',
  public.teste_consulta('authenticated', 'semperfil@exemplo.local',
    'select public.termo_fisico_ler(''a0000000-0000-0000-0000-000000000042'')')->>'code' = '42501');
select public.teste_assert('sem perfil: registrar dá 42501',
  public.teste_comando('authenticated', 'semperfil@exemplo.local',
    'select public.termo_fisico_registrar(''a0000000-0000-0000-0000-000000000042'',''ARQUIVADO'',false)')->>'code' = '42501');

-- Gestão INATIVA: o portão exige app_usuario_ativo() E usuario_e_gestao().
update public.usuarios set ativo = false where email = 'cobranca07@aelbra.com.br';
select public.teste_assert('inativo: a ADM inativa não consegue registrar (42501)',
  public.teste_comando('authenticated', 'cobranca07@aelbra.com.br',
    'select public.termo_fisico_registrar(''a0000000-0000-0000-0000-000000000042'',''ARQUIVADO'',false)')->>'code' = '42501');
select public.teste_assert('inativo: a ADM inativa não consegue ler (42501)',
  public.teste_consulta('authenticated', 'cobranca07@aelbra.com.br',
    'select public.termo_fisico_ler(''a0000000-0000-0000-0000-000000000042'')')->>'code' = '42501');
update public.usuarios set ativo = true where email = 'cobranca07@aelbra.com.br';

-- p_notificar = false: grava o registro e NÃO gera aviso.
-- Contagem capturada ANTES, em instrução separada (um único SELECT não serve,
-- porque as subconsultas compartilham o mesmo snapshot).
create temp table snap_notif as
  select count(*)::int as n from public.notificacoes where tipo = 'TERMO_FISICO';
select public.teste_assert('p_notificar=false: a gravação funciona',
  public.teste_comando('authenticated', 'amanda.seibel@aelbra.com.br',
    'select public.termo_fisico_registrar(''a0000000-0000-0000-0000-000000000042'',''EM_ANDAMENTO'',false)')->>'ok' = 'true');
select public.teste_assert('p_notificar=false: nenhum aviso novo foi gerado',
  (select count(*) from public.notificacoes where tipo = 'TERMO_FISICO') = (select n from snap_notif));
