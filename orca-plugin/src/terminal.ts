// 에디터 탭의 컨덕터 터미널. 그리는 일은 terminal-view가 하고 여기는 에디터 문서만 받아 간다.
import { mountTerminal } from './terminal-view'

mountTerminal()
// 파일 내용은 쓰지 않지만 오르카는 에디터가 문서를 받아 가야 다 떴다고 본다
void orca.document?.get()
