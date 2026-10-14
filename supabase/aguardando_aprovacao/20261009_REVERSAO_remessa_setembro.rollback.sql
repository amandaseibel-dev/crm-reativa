-- ============================================================================
-- ROLLBACK DA REVERSAO DA REMESSA DE SETEMBRO
-- Desfaz `reversao_remessa_reverter` a partir de `_backup_reversao_remessa_20261009`.
--
-- Determinístico: cada linha do backup guarda `dados_agora` (o estado no
-- momento da reversao, que e o que este arquivo devolve) e `dados_restaurados`
-- (o que a reversao gravou). Nenhuma derivacao, nenhuma regra -- so os valores
-- que estavam la.
--
-- O rollback NAO apaga as movimentacoes `REVERSAO_REMESSA` de
-- `aluno_movimentacoes`: historico e evidencia e nao se reescreve. Elas ficam,
-- e a volta atras aparece como um segundo registro.
--
-- USO: o SQL Editor do Supabase nao expande variavel de psql. Troque, no
-- texto, TODA ocorrencia de  :LOTE  pelo mesmo importacao_id passado para a
-- reversao, entre apostrofos e com o cast -- por exemplo:
--     '2f6c....-....-....-....-............'::uuid
-- Sao 6 ocorrencias. Se sobrar alguma, o Postgres acusa erro de sintaxe e
-- nada roda: a transacao ainda nao comecou a escrever.
-- ============================================================================

begin;

-- Pre-condicao: o backup existe e tem linhas deste lote.
select case
         when to_regclass('public._backup_reversao_remessa_20261009') is null
           then 'ABORTE: _backup_reversao_remessa_20261009 nao existe -- a reversao nunca rodou com p_dry_run => false.'
         else 'backup presente'
       end as pre_condicao;

select count(*) as linhas_de_backup_deste_lote
  from public._backup_reversao_remessa_20261009
 where lote = :LOTE;
-- Se vier 0, pare aqui e rode ROLLBACK; -- nao ha o que restaurar.

-- 1. Titulos: devolve o estado que estava gravado quando a reversao rodou.
update public.acordos_titulos t
   set situacao        = b.dados_agora ->> 'situacao',
       status          = b.dados_agora ->> 'status',
       saldo_corrigido = (b.dados_agora ->> 'saldo_corrigido')::numeric,
       valor_original  = (b.dados_agora ->> 'valor_original')::numeric,
       valor_em_aberto = (b.dados_agora ->> 'valor_em_aberto')::numeric,
       vencimento      = (b.dados_agora ->> 'vencimento')::date,
       importacao_id   = nullif(b.dados_agora ->> 'importacao_id','')::uuid,
       atualizado_em   = now()
  from public._backup_reversao_remessa_20261009 b
 where b.lote = :LOTE
   and b.tabela = 'acordos_titulos'
   and t.id = b.registro_id;

-- 2. Alunos.
update public.alunos al
   set status_jornada     = b.dados_agora ->> 'status_jornada',
       status_atual       = b.dados_agora ->> 'status_atual',
       status_acionamento = b.dados_agora ->> 'status_acionamento',
       proxima_acao       = b.dados_agora ->> 'proxima_acao'
  from public._backup_reversao_remessa_20261009 b
 where b.lote = :LOTE
   and b.tabela = 'alunos'
   and al.id = b.registro_id;

-- 3. Casos acompanham o aluno, como na reversao.
update public.casos c
   set status_jornada = b.dados_agora ->> 'status_jornada',
       status_atual   = b.dados_agora ->> 'status_atual',
       caso_atualizado_por = 'rollback_reversao_remessa_20261009',
       caso_atualizado_em  = now()
  from public._backup_reversao_remessa_20261009 b
 where b.lote = :LOTE
   and b.tabela = 'alunos'
   and c.aluno_id = b.registro_id;

-- 4. Registra a volta atras na ficha.
insert into public.aluno_movimentacoes
  (aluno_id, tipo, descricao, status_anterior, status_novo,
   registrado_por_nome, registrado_por_email, registrado_em)
select b.registro_id::text, 'ROLLBACK_REVERSAO_REMESSA',
       'Rollback da reversao de 09/10/2026: o estado anterior a reversao foi '
       || 'restaurado a partir de _backup_reversao_remessa_20261009.',
       b.dados_restaurados ->> 'status_jornada',
       b.dados_agora       ->> 'status_jornada',
       'Sistema', 'rollback_reversao_remessa', now()
  from public._backup_reversao_remessa_20261009 b
 where b.lote = :LOTE and b.tabela = 'alunos';

-- Confira o resultado ANTES de confirmar.
select b.tabela, count(*) as linhas_restauradas
  from public._backup_reversao_remessa_20261009 b
 where b.lote = :LOTE
 group by b.tabela;

-- Troque por ROLLBACK; se os numeros nao fizerem sentido.
commit;

-- A funcao em si, se for para tirar do banco tambem:
-- drop function if exists public.reversao_remessa_reverter(uuid, boolean, integer, integer);
