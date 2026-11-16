-- AÇÕES de app_teste com dono_teste (NOSUPERUSER, BYPASSRLS), FORCE RLS ligado e CONTENÇÃO LIGADA.
-- Distingue: recusa da trigger (42501 com a mensagem da contenção); falta de grant e RLS (42501 de permissão).
\set ON_ERROR_STOP on
select public.teste_assert('dono_teste + contenção: RPC recusada pela TRIGGER (mensagem da contenção)',
  (public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$select public.registrar_administrativo_termo_fisico('a0000000-0000-0000-0000-000000000042','TERMO_FISICO_ARQUIVADO')$sql$)->>'err') like 'Registro de termo físico suspenso%');
select public.teste_assert('dono_teste + contenção: INSERT direto REGISTRO recusado pela TRIGGER',
  (public.teste_comando('authenticated','amanda.seibel@aelbra.com.br',
    $sql$insert into public.aluno_movimentacoes (aluno_id,tipo,status_novo,descricao,registrado_por_email) values ('e2','REGISTRO_ADMINISTRATIVO','TERMO_FISICO_EM_ANDAMENTO','Registro administrativo do termo físico.','amanda.seibel@aelbra.com.br')$sql$)->>'err') like 'Registro de termo físico suspenso%');
select public.teste_assert('dono_teste + contenção: operador não altera a flag (42501 de permissão, não trigger)',
  (public.teste_comando('authenticated','operador.teste@exemplo.local',
    $sql$update public.termo_fisico_contencao set contencao_ativa = false where id$sql$)->>'code') = '42501');
