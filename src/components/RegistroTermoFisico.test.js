// Registro administrativo do termo físico. O que trava aqui:
//  - o rótulo de "arquivado" não promete quitação;
//  - a situação NÃO aparece como tabulação da operação;
//  - a ficha usa o componente (e só ele, sem tabulação nova).
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import RegistroTermoFisico from "./RegistroTermoFisico";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  rotuloSituacaoTermoFisico,
  SITUACOES_TERMO_FISICO,
  classificarErroTermoFisico,
} from "../utils/termoFisico";

const aqui = dirname(fileURLToPath(import.meta.url));
const ler = (rel) => readFileSync(resolve(aqui, rel), "utf8");

describe("registro administrativo do termo físico", () => {
  it("distingue em andamento de arquivado", () => {
    expect(rotuloSituacaoTermoFisico("EM_ANDAMENTO")).toBe("Termo físico assinado, em andamento");
    expect(rotuloSituacaoTermoFisico("ARQUIVADO")).toBe("Termo físico arquivado");
    expect(rotuloSituacaoTermoFisico(null)).toBe("Sem registro");
  });

  it("'arquivado' não diz quitado nem baixa", () => {
    for (const texto of Object.values(SITUACOES_TERMO_FISICO)) {
      expect(texto.toLowerCase()).not.toMatch(/quitad|baixa|pago/);
    }
  });

  it("não há código de termo físico em nenhuma lista da operação", () => {
    for (const arquivo of [
      "../pages/Aluno.jsx",
      "../components/PainelCarteira.jsx",
      "../pages/FilaOperacional.jsx",
      "../utils/tabulacoes.js",
      "../utils/rotulosStatus.js",
    ]) {
      expect(ler(arquivo), arquivo).not.toMatch(/TERMO_FISICO/);
    }
  });

  it("a ficha monta o componente, e só ele", () => {
    const ficha = ler("../pages/Aluno.jsx");
    expect(ficha).toMatch(/import RegistroTermoFisico from "\.\.\/components\/RegistroTermoFisico"/);
    expect((ficha.match(/<RegistroTermoFisico /g) || []).length).toBe(1);
  });

  it("operação: renderização com podeVer=false é vazia (nada para quem não pode)", () => {
    expect(renderToStaticMarkup(createElement(RegistroTermoFisico, { alunoId: "1", podeVer: false }))).toBe("");
  });

  it("falta de permissão some; qualquer outra falha avisa a gestão (não some em silêncio)", () => {
    expect(classificarErroTermoFisico({ code: "42501", message: "sem permissão" })).toBe("SEM_PERMISSAO");
    expect(classificarErroTermoFisico({ code: "", message: "Sem permissão para o registro" })).toBe("SEM_PERMISSAO");
    // migração ainda não aplicada: função inexistente
    expect(classificarErroTermoFisico({ code: "PGRST202", message: "Could not find the function" })).toBe("FALHA_TECNICA");
    expect(classificarErroTermoFisico({ code: "42883", message: "function does not exist" })).toBe("FALHA_TECNICA");
    expect(classificarErroTermoFisico({ message: "Failed to fetch" })).toBe("FALHA_TECNICA");
    expect(classificarErroTermoFisico(null)).toBeNull();
  });

  it("a operação não recebe o componente: a ficha passa podeVer pela mesma régua da tela", () => {
    const ficha = ler("../pages/Aluno.jsx");
    expect(ficha).toMatch(/<RegistroTermoFisico key=\{alunoSelecionado\.id\} alunoId=\{alunoSelecionado\.id\} podeVer=\{podeVerTudo\(usuarioLogado\?\.email\)\} \/>/);
    const componente = ler("./RegistroTermoFisico.jsx");
    // operador: sem podeVer, nem chama a RPC nem renderiza
    expect(componente).toMatch(/if \(!podeVer\) return null;/);
    expect(componente).toMatch(/if \(!alunoId \|\| !podeVer\) return undefined;/);
  });

  it("o componente só chama as RPCs de termo físico, sem escrever direto em tabela", () => {
    const fonte = ler("./RegistroTermoFisico.jsx");
    expect(fonte).toMatch(/rpc\("termo_fisico_ler"/);
    expect(fonte).toMatch(/rpc\("termo_fisico_registrar"/);
    expect(fonte).not.toMatch(/\.from\(/);
  });
});
