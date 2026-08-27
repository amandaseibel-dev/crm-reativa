-- Passo intermediario, SUBSTITUIDO no mesmo dia.
--
-- Esta migration ligou o sinal `reativa.importando` dentro de importar_acordos
-- (para a trava sinalizar a duplicidade em vez de derrubar o lote) e fez a
-- funcao devolver acordos_duplicados_sinalizados.
--
-- Vinte minutos depois, 20260827132340_import_nao_ressuscita_quem_foi_quitado_
-- esta_semana.sql reescreveu a MESMA funcao inteira, ja com o sinal e a
-- contagem dentro. Repetir o corpo aqui seria duplicar cem linhas que a
-- proxima migration reescreve por completo -- e o estado final e identico com
-- ou sem este passo.
--
-- Fica registrado para a ordem do historico bater com a de producao
-- (supabase_migrations.schema_migrations, versao 20260827131950).

select 1;
