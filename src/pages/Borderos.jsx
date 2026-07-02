import { useState } from "react";
import * as XLSX from "xlsx";
import { supabase } from "../services/supabase";

function limparCpf(valor) {
  const digitos = String(valor || "").replace(/\D/g, "");
  if (!digitos) return null;
  return digitos.padStart(11, "0");
}

function parseValor(valor) {
  if (typeof valor === "number") return valor;
  const texto = String(valor || "")
    .replace("R$", "")
    .trim()
    .replace(/\./g, "")
    .replace(",", ".");
  const numero = parseFloat(texto);
  return Number.isNaN(numero) ? null : numero;
}

function parseDataBr(valor) {
  if (!valor) return null;
  const texto = String(valor).trim();
  const partes = texto.split("/");
  if (partes.length !== 3) return null;
  const [dia, mes, ano] = partes;
  return `${ano}-${mes.padStart(2, "0")}-${dia.padStart(2, "0")}`;
}

function extrairNumeroBordero(nomeArquivo) {
  const match = String(nomeArquivo || "").match(/(\d+)/);
  return match ? match[1] : nomeArquivo;
}

export default function Borderos() {
  const [arquivo, setArquivo] = useState(null);
  const [processando, setProcessando] = useState(false);
  const [preview, setPreview] = useState(null);
  const [importando, setImportando] = useState(false);
  const [resultado, setResultado] = useState(null);
  const [erro, setErro] = useState("");

  async function selecionarArquivo(e) {
    const arquivoSelecionado = e.target.files?.[0];
    if (!arquivoSelecionado) return;

    setArquivo(arquivoSelecionado);
    setResultado(null);
    setErro("");
    setProcessando(true);

    try {
      const buffer = await arquivoSelecionado.arrayBuffer();
      const workbook = XLSX.read(buffer, { type: "array" });
      const primeiraAba = workbook.SheetNames[0];
      const linhasBrutas = XLSX.utils.sheet_to_json(workbook.Sheets[primeiraAba], {
        raw: false,
      });

      if (linhasBrutas.length === 0) {
        setErro("Não encontrei linhas nessa planilha.");
        setProcessando(false);
        return;
      }

      const linhas = linhasBrutas
        .map((linha) => ({
          cpfOriginal: linha.cpfcnpj,
          cpfLimpo: limparCpf(linha.cpfcnpj),
          nome: linha.nome,
          numTitulo: String(linha.num_titulo || "").trim(),
          numParcela: linha.num_parcela,
          vencimento: parseDataBr(linha.datavencimento),
          valor: parseValor(linha.valorparcela),
          curso: linha.NomeTipoTitulo || null,
          unidade: linha.estabNome || null,
          email: String(linha.email || "").split(";")[0].trim() || null,
          telefone: linha.dddRes && linha.foneRes
            ? `(${linha.dddRes}) ${linha.foneRes}`
            : linha.foneRes || null,
        }))
        .filter((linha) => linha.numTitulo);

      const cpfs = [...new Set(linhas.map((l) => l.cpfLimpo).filter(Boolean))];
      const titulos = [...new Set(linhas.map((l) => l.numTitulo))];

      const { data: alunosEncontrados } = await supabase
        .from("alunos")
        .select("id, nome, cpf, email, telefone, curso, unidade")
        .in("cpf", cpfs);

      const { data: titulosExistentes } = await supabase
        .from("acordos_titulos")
        .select("documento, situacao")
        .in("documento", titulos);

      const mapaAlunosPorCpf = {};
      for (const aluno of alunosEncontrados || []) {
        mapaAlunosPorCpf[aluno.cpf] = aluno;
      }

      const mapaTitulos = {};
      for (const titulo of titulosExistentes || []) {
        mapaTitulos[titulo.documento] = titulo;
      }

      // Pra quem não bateu por CPF, tenta achar pelo nome antes de decidir
      // criar um cadastro novo.
      const nomesParaTentar = [
        ...new Set(
          linhas
            .filter((l) => !(l.cpfLimpo && mapaAlunosPorCpf[l.cpfLimpo]))
            .map((l) => String(l.nome || "").trim())
            .filter(Boolean)
        ),
      ];

      const mapaAlunosPorNome = {};
      if (nomesParaTentar.length > 0) {
        const { data: porNome } = await supabase
          .from("alunos")
          .select("id, nome, cpf, email, telefone, curso, unidade")
          .in("nome", nomesParaTentar);

        for (const aluno of porNome || []) {
          mapaAlunosPorNome[aluno.nome.trim().toLowerCase()] = aluno;
        }
      }

      const linhasComStatus = linhas.map((linha) => {
        const porCpf = linha.cpfLimpo ? mapaAlunosPorCpf[linha.cpfLimpo] : null;
        const porNome = !porCpf
          ? mapaAlunosPorNome[String(linha.nome || "").trim().toLowerCase()]
          : null;
        const aluno = porCpf || porNome || null;

        return {
          ...linha,
          aluno,
          origemMatch: porCpf ? "cpf" : porNome ? "nome" : "novo",
          jaExiste: Boolean(mapaTitulos[linha.numTitulo]),
          situacaoAtual: mapaTitulos[linha.numTitulo]?.situacao || null,
        };
      });

      const encontradosCpf = linhasComStatus.filter((l) => l.origemMatch === "cpf").length;
      const encontradosNome = linhasComStatus.filter((l) => l.origemMatch === "nome").length;
      const novosAlunos = linhasComStatus.filter((l) => l.origemMatch === "novo").length;
      const existentes = linhasComStatus.filter((l) => l.jaExiste).length;

      const numeroBordero = extrairNumeroBordero(arquivoSelecionado.name);

      // Avisa se esse mesmo bordero (mesmo numero) ja foi importado antes,
      // pra evitar reenvio sem perceber. Nao bloqueia (pode ser reforço de
      // dados de propósito), so deixa bem visivel antes de confirmar.
      const { data: importacoesAnteriores } = await supabase
        .from("importacoes")
        .select("id, created_at, usuario, qtd_registros")
        .eq("tipo", "BORDERO")
        .eq("referencia", numeroBordero)
        .eq("status", "CONCLUIDO")
        .order("created_at", { ascending: false })
        .limit(1);

      setPreview({
        linhas: linhasComStatus,
        totais: {
          total: linhasComStatus.length,
          encontradosCpf,
          encontradosNome,
          novosAlunos,
          existentes,
        },
        numeroBordero,
        jaImportadoAntes: importacoesAnteriores?.[0] || null,
      });
    } catch (err) {
      console.error(err);
      setErro("Não consegui ler essa planilha. Confira se é um .xls/.xlsx válido.");
    } finally {
      setProcessando(false);
    }
  }

  async function confirmarImportacao() {
    if (!preview) return;

    setImportando(true);
    setErro("");

    try {
      const { data: userData } = await supabase.auth.getUser();
      const email = userData?.user?.email || "desconhecido";

      const { data: importacao, error: erroImportacao } = await supabase
        .from("importacoes")
        .insert({
          tipo: "BORDERO",
          referencia: preview.numeroBordero,
          arquivo_nome: arquivo?.name || null,
          usuario: email,
          qtd_registros: preview.linhas.length,
          status: "PROCESSANDO",
        })
        .select()
        .single();

      if (erroImportacao) {
        setErro("Erro ao registrar a importação: " + erroImportacao.message);
        setImportando(false);
        return;
      }

      let ignorados = 0;
      const nomesNaoEncontrados = [];
      const nomesCriados = [];

      // 1) Cria em lote (uma chamada só) os alunos que não bateram nem por
      // CPF nem por nome, em vez de um insert por linha.
      const linhasSemAluno = preview.linhas.filter((l) => !l.aluno);
      let alunosNovosPorCpf = {};

      if (linhasSemAluno.length > 0) {
        const { data: novosAlunos, error: erroNovos } = await supabase
          .from("alunos")
          .insert(
            linhasSemAluno.map((l) => ({
              nome: l.nome,
              cpf: l.cpfLimpo,
              email: l.email,
              telefone: l.telefone,
              curso: l.curso,
              unidade: l.unidade,
              status_jornada: "CONTATAR",
              status_atual: "CONTATAR",
            }))
          )
          .select();

        if (erroNovos) {
          nomesNaoEncontrados.push(...linhasSemAluno.map((l) => l.nome));
          ignorados += linhasSemAluno.length;
        } else {
          for (const aluno of novosAlunos || []) {
            alunosNovosPorCpf[aluno.cpf] = aluno;
          }
          nomesCriados.push(...linhasSemAluno.map((l) => l.nome));
        }
      }

      const alunosCriados = Object.keys(alunosNovosPorCpf).length;

      // 2) Completa telefone/email/curso/unidade só de quem já existia e
      // estava com algum desses campos vazio — em paralelo, não em fila.
      const completar = preview.linhas.filter((l) => l.aluno).map((l) => {
        const aluno = l.aluno;
        const camposParaCompletar = {};
        if (!aluno.email && l.email) camposParaCompletar.email = l.email;
        if (!aluno.telefone && l.telefone) camposParaCompletar.telefone = l.telefone;
        if (!aluno.curso && l.curso) camposParaCompletar.curso = l.curso;
        if (!aluno.unidade && l.unidade) camposParaCompletar.unidade = l.unidade;

        if (Object.keys(camposParaCompletar).length === 0) return null;
        return supabase.from("alunos").update(camposParaCompletar).eq("id", aluno.id);
      }).filter(Boolean);

      await Promise.all(completar);

      // 3) Grava todos os títulos em uma única chamada (upsert por
      // "documento"), em vez de um insert/update por linha.
      const registrosTitulos = [];

      for (const linha of preview.linhas) {
        if (linha.jaExiste && linha.situacaoAtual === "PAGO") {
          ignorados += 1;
          continue;
        }

        const aluno = linha.aluno || alunosNovosPorCpf[linha.cpfLimpo];
        if (!aluno) {
          ignorados += 1;
          continue;
        }

        registrosTitulos.push({
          aluno_id: aluno.id,
          cpf: linha.cpfLimpo,
          documento: linha.numTitulo,
          vencimento: linha.vencimento,
          valor_original: linha.valor,
          saldo_corrigido: linha.valor,
          situacao: "ABERTO",
          tipo_boleto: linha.curso,
          importacao_id: importacao.id,
        });
      }

      let inseridos = 0;
      let atualizados = 0;

      if (registrosTitulos.length > 0) {
        const { error: erroTitulos } = await supabase
          .from("acordos_titulos")
          .upsert(registrosTitulos, { onConflict: "documento" });

        if (erroTitulos) {
          setErro("Erro ao gravar os títulos: " + erroTitulos.message);
        } else {
          const existentesSet = new Set(
            preview.linhas.filter((l) => l.jaExiste).map((l) => l.numTitulo)
          );
          inseridos = registrosTitulos.filter((r) => !existentesSet.has(r.documento)).length;
          atualizados = registrosTitulos.filter((r) => existentesSet.has(r.documento)).length;
        }
      }

      await supabase
        .from("importacoes")
        .update({ status: "CONCLUIDO" })
        .eq("id", importacao.id);

      setResultado({ inseridos, atualizados, ignorados, alunosCriados, nomesCriados, nomesNaoEncontrados });
      setPreview(null);
      setArquivo(null);
    } catch (err) {
      console.error(err);
      setErro("Erro ao importar. Tente novamente.");
    } finally {
      setImportando(false);
    }
  }

  return (
    <div className="main">
      <h1>Borderôs</h1>
      <p style={{ opacity: 0.75, marginBottom: 20 }}>
        Sobe a planilha de mensalidades/parcelas em aberto. Casa por CPF e não duplica
        títulos já importados — só atualiza. Nada é gravado até você confirmar.
      </p>

      <div style={estilos.caixaUpload}>
        <input type="file" accept=".xls,.xlsx" onChange={selecionarArquivo} />
        {processando && <p style={{ marginTop: 10 }}>Lendo planilha...</p>}
      </div>

      {erro && <p style={{ color: "#f87171", marginTop: 12 }}>{erro}</p>}

      {resultado && (
        <div style={estilos.caixaSucesso}>
          <strong>Importação concluída.</strong>
          <p style={{ margin: "6px 0 0" }}>
            {resultado.inseridos} títulos novos, {resultado.atualizados} atualizados,{" "}
            {resultado.alunosCriados} alunos novos cadastrados, {resultado.ignorados}{" "}
            ignorados (já pagos).
          </p>

          {resultado.nomesCriados?.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: "pointer", fontSize: 13 }}>
                Ver os {resultado.nomesCriados.length} alunos criados agora
              </summary>
              <ul style={{ fontSize: 13, opacity: 0.85, marginTop: 6 }}>
                {resultado.nomesCriados.map((nome, indice) => (
                  <li key={indice}>{nome}</li>
                ))}
              </ul>
            </details>
          )}

          {resultado.nomesNaoEncontrados?.length > 0 && (
            <details style={{ marginTop: 10 }}>
              <summary style={{ cursor: "pointer", fontSize: 13, color: "#fcd34d" }}>
                Relatório: {resultado.nomesNaoEncontrados.length} não importados
              </summary>
              <ul style={{ fontSize: 13, opacity: 0.85, marginTop: 6 }}>
                {resultado.nomesNaoEncontrados.map((nome, indice) => (
                  <li key={indice}>{nome}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {preview && (
        <div style={{ marginTop: 20 }}>
          {preview.jaImportadoAntes && (
            <div style={estilos.avisoDuplicado}>
              <strong>⚠️ Este borderô (nº {preview.numeroBordero}) já foi importado antes</strong>
              <p style={{ margin: "4px 0 0", fontSize: 13 }}>
                Em {new Date(preview.jaImportadoAntes.created_at).toLocaleString("pt-BR")}, por{" "}
                {preview.jaImportadoAntes.usuario} ({preview.jaImportadoAntes.qtd_registros}{" "}
                registros). Confirmar de novo não duplica os títulos, só atualiza os valores —
                mas confira se é isso mesmo que você quer antes de continuar.
              </p>
            </div>
          )}

          <div style={estilos.grade}>
            <div style={estilos.cartao}>
              <div style={estilos.numero}>{preview.totais.total}</div>
              <div style={estilos.label}>Total no arquivo</div>
            </div>
            <div style={{ ...estilos.cartao, background: "rgba(34,197,94,0.1)" }}>
              <div style={{ ...estilos.numero, color: "#86efac" }}>
                {preview.totais.encontradosCpf}
              </div>
              <div style={estilos.label}>Encontrados por CPF</div>
            </div>
            <div style={{ ...estilos.cartao, background: "rgba(56,189,248,0.1)" }}>
              <div style={{ ...estilos.numero, color: "#7dd3fc" }}>
                {preview.totais.encontradosNome}
              </div>
              <div style={estilos.label}>Encontrados pelo nome</div>
            </div>
            <div style={{ ...estilos.cartao, background: "rgba(251,191,36,0.1)" }}>
              <div style={{ ...estilos.numero, color: "#fcd34d" }}>
                {preview.totais.novosAlunos}
              </div>
              <div style={estilos.label}>Alunos novos (serão criados)</div>
            </div>
            <div style={estilos.cartao}>
              <div style={estilos.numero}>{preview.totais.existentes}</div>
              <div style={estilos.label}>Títulos já existentes</div>
            </div>
          </div>

          <p style={{ fontSize: 13, opacity: 0.75, margin: "16px 0 8px" }}>
            Prévia das primeiras linhas
          </p>

          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(148,163,184,0.3)" }}>
                  <th style={{ padding: "8px 10px" }}>Aluno</th>
                  <th style={{ padding: "8px 10px" }}>Título</th>
                  <th style={{ padding: "8px 10px" }}>Vencimento</th>
                  <th style={{ padding: "8px 10px" }}>Valor</th>
                  <th style={{ padding: "8px 10px" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {preview.linhas.slice(0, 20).map((linha, indice) => (
                  <tr key={indice} style={{ borderBottom: "1px solid rgba(148,163,184,0.12)" }}>
                    <td style={{ padding: "8px 10px" }}>{linha.nome}</td>
                    <td style={{ padding: "8px 10px", opacity: 0.7 }}>{linha.numTitulo}</td>
                    <td style={{ padding: "8px 10px" }}>
                      {linha.vencimento
                        ? new Date(linha.vencimento + "T00:00:00").toLocaleDateString("pt-BR")
                        : "-"}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      {linha.valor != null
                        ? linha.valor.toLocaleString("pt-BR", {
                            style: "currency",
                            currency: "BRL",
                          })
                        : "-"}
                    </td>
                    <td style={{ padding: "8px 10px" }}>
                      {linha.origemMatch === "novo" ? (
                        <span style={estilos.tagAmarela}>Aluno novo (será criado)</span>
                      ) : linha.jaExiste ? (
                        <span style={estilos.tagNeutra}>Já existe (atualiza)</span>
                      ) : linha.origemMatch === "nome" ? (
                        <span style={estilos.tagAzul}>Encontrado pelo nome</span>
                      ) : (
                        <span style={estilos.tagVerde}>Encontrado</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <button
            type="button"
            onClick={confirmarImportacao}
            disabled={importando}
            style={estilos.botaoConfirmar}
          >
            {importando ? "Importando..." : "Confirmar importação"}
          </button>
        </div>
      )}
    </div>
  );
}

const estilos = {
  caixaUpload: {
    padding: 20,
    borderRadius: 10,
    border: "1px dashed rgba(148,163,184,0.4)",
    background: "rgba(148,163,184,0.05)",
  },
  avisoDuplicado: {
    padding: "12px 16px",
    marginBottom: 16,
    borderRadius: 10,
    background: "rgba(251,191,36,0.1)",
    border: "1px solid rgba(251,191,36,0.4)",
  },
  caixaSucesso: {
    marginTop: 16,
    padding: "12px 16px",
    borderRadius: 10,
    background: "rgba(34,197,94,0.1)",
    border: "1px solid rgba(34,197,94,0.3)",
  },
  grade: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
    gap: 12,
  },
  cartao: {
    padding: 16,
    borderRadius: 10,
    background: "rgba(148,163,184,0.08)",
  },
  numero: {
    fontSize: 24,
    fontWeight: 800,
  },
  label: {
    fontSize: 12,
    opacity: 0.75,
    marginTop: 4,
  },
  tagVerde: {
    background: "rgba(34,197,94,0.16)",
    color: "#86efac",
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 999,
  },
  tagAmarela: {
    background: "rgba(251,191,36,0.16)",
    color: "#fcd34d",
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 999,
  },
  tagNeutra: {
    background: "rgba(148,163,184,0.15)",
    color: "#cbd5e1",
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 999,
  },
  tagAzul: {
    background: "rgba(56,189,248,0.16)",
    color: "#7dd3fc",
    fontSize: 12,
    padding: "3px 10px",
    borderRadius: 999,
  },
  botaoConfirmar: {
    marginTop: 16,
    padding: "10px 20px",
    borderRadius: 8,
    border: "1px solid rgba(34,197,94,0.6)",
    background: "rgba(34,197,94,0.16)",
    color: "#86efac",
    fontWeight: 600,
    cursor: "pointer",
  },
};
